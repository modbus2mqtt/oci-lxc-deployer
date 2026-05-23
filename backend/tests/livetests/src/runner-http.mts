/**
 * Runner-side HTTP helper with optional machine-token Bearer auth.
 *
 * Why this exists:
 *   The livetest runner makes ~12 direct fetch() calls to /api/* endpoints
 *   on the deployer (test-scenarios discovery, stack lookups, queue-worker,
 *   bundle pulls, …). With an OIDC-enabled Hub, every one of those would
 *   401. The CLI binary (cli/src/cli-api-client.mts) has its own
 *   client_credentials → Bearer JWT path; this module mirrors that path
 *   for the runner's own fetches, so the same DEPLOYER_OIDC_MACHINE_*
 *   credentials power both the CLI subprocess and the runner.
 *
 * Usage:
 *   const auth: RunnerAuthContext = {};
 *   // optionally populate auth.oidcCreds from `loadOidcCredsFromStack(...)`
 *   const resp = await runnerHttpJson(auth, `${apiUrl}/api/version`);
 *   if (resp.ok) console.log(resp.body);
 */

import { createLogger } from "../../../src/logger/index.mjs";

const logger = createLogger("runner-http");

export interface RunnerOidcCreds {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
}

export interface RunnerAuthContext {
  /** Machine credentials read from the oidc_<stackName> stack via
   *  loadOidcCredsFromStack. Populated lazily by the scenario-executor
   *  once the Zitadel-provided stack is reachable. Leave undefined for
   *  OIDC-disabled Hubs — every request goes through unauthenticated. */
  oidcCreds?: RunnerOidcCreds;
  /** Cached Bearer JWT from the last successful client_credentials grant.
   *  Refreshed lazily on each runnerHttpJson when within 60s of expiry. */
  token?: string;
  /** unix-seconds expiry from the token endpoint's `expires_in`. */
  tokenExp?: number;
}

export interface RunnerHttpResult<T = unknown> {
  ok: boolean;
  status: number;
  body?: T;
  /** When set, the body could not be JSON-parsed and is returned verbatim. */
  text?: string;
}

/**
 * Fetch a Bearer JWT via OIDC client_credentials grant. Mirrors the CLI's
 * implementation in [cli-api-client.mts:102-134]. Sets ctx.token + tokenExp.
 * No-op if ctx.oidcCreds is unset.
 */
async function fetchMachineToken(ctx: RunnerAuthContext): Promise<void> {
  if (!ctx.oidcCreds) return;
  const { issuerUrl, clientId, clientSecret } = ctx.oidcCreds;
  const tokenUrl = `${issuerUrl}/oauth/v2/token`;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const params = new URLSearchParams({
    grant_type: "client_credentials",
    scope: "openid",
  });
  const resp = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: params.toString(),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`OIDC token request failed (${resp.status}): ${detail.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { access_token: string; expires_in?: number };
  ctx.token = data.access_token;
  ctx.tokenExp = Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600);
  logger.info("Runner machine-token refreshed", {
    issuer: issuerUrl,
    expiresInSec: data.expires_in ?? 3600,
  });
}

/**
 * Ensure ctx.token is present and not within 60s of expiry. Triggers a
 * client_credentials grant if needed.
 */
async function ensureToken(ctx: RunnerAuthContext): Promise<void> {
  if (!ctx.oidcCreds) return;
  const now = Math.floor(Date.now() / 1000);
  if (ctx.token && ctx.tokenExp && ctx.tokenExp - now > 60) return;
  await fetchMachineToken(ctx);
}

/**
 * Authenticated fetch helper. Attaches Authorization: Bearer when ctx.token
 * is available (which requires ctx.oidcCreds populated). On 401 with a token
 * present, force-refreshes the token once and retries — guards against the
 * tokenExp being slightly off from server clock skew. Returns a normalized
 * { ok, status, body } shape.
 */
export async function runnerHttpJson<T = unknown>(
  ctx: RunnerAuthContext,
  url: string,
  init: RequestInit = {},
): Promise<RunnerHttpResult<T>> {
  await ensureToken(ctx);
  const headers = new Headers(init.headers);
  if (ctx.token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${ctx.token}`);
  }
  let resp = await fetch(url, { ...init, headers });
  if (resp.status === 401 && ctx.oidcCreds) {
    // Token may have expired between ensureToken() and the request. Force
    // a fresh grant and retry once.
    try {
      await fetchMachineToken(ctx);
      const retryHeaders = new Headers(init.headers);
      if (ctx.token) retryHeaders.set("Authorization", `Bearer ${ctx.token}`);
      resp = await fetch(url, { ...init, headers: retryHeaders });
    } catch (err: any) {
      logger.warn("Runner token-refresh-on-401 failed", { url, error: err?.message });
    }
  }
  return parseResponse<T>(resp);
}

/**
 * Same as runnerHttpJson but returns the response as text — useful for
 * endpoints that don't return JSON (e.g. /api/ve/debug/<key>/<file>.md).
 */
export async function runnerHttpText(
  ctx: RunnerAuthContext,
  url: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; text?: string }> {
  await ensureToken(ctx);
  const headers = new Headers(init.headers);
  if (ctx.token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${ctx.token}`);
  }
  let resp = await fetch(url, { ...init, headers });
  if (resp.status === 401 && ctx.oidcCreds) {
    try {
      await fetchMachineToken(ctx);
      const retryHeaders = new Headers(init.headers);
      if (ctx.token) retryHeaders.set("Authorization", `Bearer ${ctx.token}`);
      resp = await fetch(url, { ...init, headers: retryHeaders });
    } catch { /* fall through with the 401 */ }
  }
  if (!resp.ok) return { ok: false, status: resp.status };
  const text = await resp.text();
  return { ok: true, status: resp.status, text };
}

async function parseResponse<T>(resp: Response): Promise<RunnerHttpResult<T>> {
  const status = resp.status;
  if (!resp.ok) return { ok: false, status };
  const raw = await resp.text();
  if (!raw) return { ok: true, status };
  try {
    return { ok: true, status, body: JSON.parse(raw) as T };
  } catch {
    return { ok: true, status, text: raw };
  }
}
