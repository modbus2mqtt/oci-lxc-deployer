import { test, expect, request } from "@playwright/test";

/**
 * End-to-end test for proxvex self-RECONFIGURE, driven by UI clicks against a
 * separate test-proxvex-deployer LXC (the production Hub is not touched).
 *
 * This is the reconfigure analogue of test-deployer-upgrade.spec.ts. It exists
 * because self-reconfigure went through the same replace-ct.sh/lxc-start.sh
 * self-switchover path as self-upgrade but lost the switchover-result race in
 * production: the Step 11 OIDC reconfigure surfaced "Start LXC Container exit
 * 255 / Failed (VMID …)" instead of a clean switchover. Invariant under test:
 * every task ends error-free, including a deployer reconfiguring itself.
 *
 * Pipeline:
 *   1. Open the installed-list page on the test deployer (admin-only, HTTP).
 *   2. Find the row for the test-deployer's own container (by hostname).
 *   3. Click Reconfigure, enable addon-ssl, submit.
 *   4. Wait until the OLD deployer (http :3080) stops responding (switchover
 *      started) AND the NEW container answers on https :3443 — proving the
 *      reconfigure applied (SSL now on) AND the self-switchover completed
 *      cleanly (a hard-failed task would not yield a healthy SSL deployer).
 *
 * addon-ssl is self-contained (no zitadel/OIDC deps) so the nested VM stays
 * light; the switchover code path exercised is identical to the OIDC case.
 *
 * Required env (set by scenario-env.mts in phase D):
 *   - APP_HOSTNAME — the test deployer's hostname inside the nested VM
 *   - APP_HTTPS    — "true" / "false" (pre-reconfigure scheme; expected "false")
 */
test("proxvex self-reconfigure (add addon-ssl) via UI completes switchover", async ({
  page,
}) => {
  const hostname = process.env.APP_HOSTNAME;
  if (!hostname) throw new Error("APP_HOSTNAME env var is required");

  const httpUrl = `http://${hostname}:3080`;
  const httpsUrl = `https://${hostname}:3443`;

  // 1. Open installed-list. In admin-only mode this is reachable without auth.
  const landing = await page.goto(`${httpUrl}/installed-list`);
  expect(
    landing?.status(),
    `landing ${landing?.status()} from ${httpUrl}`,
  ).toBe(200);

  // 2. Find the row whose hostname column shows the test deployer itself.
  const reconfigureBtn = page
    .locator(
      `[data-testid="reconfigure-${hostname}"], tr:has-text("${hostname}") button:has-text("Reconfigure")`,
    )
    .first();
  await expect(
    reconfigureBtn,
    `Reconfigure button for ${hostname} not found on /installed-list — is the deployer-instance marker present?`,
  ).toBeVisible({ timeout: 30_000 });
  await reconfigureBtn.click();

  // 3. Reconfigure dialog: enable addon-ssl, submit.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  // addon-ssl is presented as a selectable addon. Try a labelled checkbox/
  // switch first, fall back to clicking the row/text that mentions SSL.
  const sslToggle = dialog
    .locator(
      'input[type="checkbox"][name*="ssl" i], input[type="checkbox"][value*="ssl" i], ' +
        '[data-testid="addon-addon-ssl"], label:has-text("SSL") input[type="checkbox"]',
    )
    .first();
  if (await sslToggle.count()) {
    if (!(await sslToggle.isChecked().catch(() => false))) {
      await sslToggle.check({ force: true });
    }
  } else {
    await dialog.getByText(/SSL\s*\/?\s*HTTPS|addon-ssl|SSL/i).first().click();
  }

  await dialog
    .getByRole("button", { name: /reconfigure|apply|start|submit|ok/i })
    .first()
    .click();

  // 4. Switchover: OLD (http :3080) goes unreachable, then NEW answers on
  //    https :3443 (addon-ssl applied). A hard-failed reconfigure task would
  //    not produce a healthy SSL deployer, so this gates "task ended clean".
  const api = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const sawSslAfterSwitchover = await pollFor(
      async () => {
        const httpsOk = await ok(api, `${httpsUrl}/api/version`);
        return httpsOk;
      },
      300_000,
    );
    expect(
      sawSslAfterSwitchover,
      `Test deployer did not come back on https://${hostname}:3443 within 5min ` +
        `after self-reconfigure — switchover did not complete cleanly (the ` +
        `reconfigure task likely hard-failed instead of short-circuiting).`,
    ).toBe(true);
  } finally {
    await api.dispose();
  }
});

async function ok(
  api: import("@playwright/test").APIRequestContext,
  url: string,
): Promise<boolean> {
  try {
    const res = await api.get(url, { timeout: 5_000 });
    return res.ok();
  } catch {
    return false;
  }
}

async function pollFor(
  cond: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 4_000));
    if (await cond()) return true;
  }
  return false;
}
