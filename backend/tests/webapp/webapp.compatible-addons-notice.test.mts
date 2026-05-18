import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { ApiUri, ICompatibleAddonsResponse } from "@src/types.mjs";
import {
  createWebAppTestSetup,
  type WebAppTestSetup,
} from "../helper/webapp-test-helper.mjs";

// Verifies the CompatibleAddons route surfaces a per-application
// `## <addon-id>` section from the app's application.md as the addon's
// notice (frontend manual-setup warning), and leaves it unset otherwise.
describe("WebApp CompatibleAddons per-app notice", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;

  beforeEach(async () => {
    process.env.LXC_MANAGER_TEST_MODE = "true";
    setup = await createWebAppTestSetup(import.meta.url, {
      jsonIncludePatterns: ["^addons/addon-mtls\\.(json|md)$"],
      fixturesIncludePatterns: ["^applications/test-mtls-(doc|nodoc)/.*"],
    });
    app = setup.app;
  });

  afterEach(() => {
    delete process.env.LXC_MANAGER_TEST_MODE;
    setup.cleanup();
  });

  const getAddons = async (
    applicationId: string,
  ): Promise<ICompatibleAddonsResponse> => {
    const url = ApiUri.CompatibleAddons.replace(":application", applicationId);
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    return res.body as ICompatibleAddonsResponse;
  };

  it("overrides addon.notice from the app's ## addon-mtls section", async () => {
    const body = await getAddons("test-mtls-doc");
    const mtls = body.addons.find((a) => a.id === "addon-mtls");
    expect(mtls).toBeDefined();
    expect(mtls?.notice).toContain("MANUAL-MTLS-FIXTURE-MARKER");
    // The section must not bleed into other headings.
    expect(mtls?.notice).not.toContain("Unrelated section");
    expect(mtls?.notice).not.toContain("must not leak");
  });

  it("leaves addon.notice unset when the app has no such section", async () => {
    const body = await getAddons("test-mtls-nodoc");
    const mtls = body.addons.find((a) => a.id === "addon-mtls");
    expect(mtls).toBeDefined();
    // addon-mtls.md has no global "## Notice" section either.
    expect(mtls?.notice).toBeUndefined();
  });
});
