import { IStack } from "../types.mjs";
import { IStackProvider } from "./stack-provider.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("remote-stack-provider");

/**
 * Remote stack provider: delegates stack operations to the Hub deployer
 * via HTTP(S).
 *
 * Async via native `fetch` so Spoke→Hub calls never block the Node event
 * loop. The earlier `spawnSync("curl")` was a workaround for an old sync
 * IStackProvider interface; that interface is now async too.
 *
 * Auth: If a bearer token getter is provided and returns a token, it's
 * sent as `Authorization: Bearer <token>`. Otherwise the request goes
 * unauthenticated (Hub without OIDC accepts this).
 *
 * TLS trust: TOFU is provided by the global `NODE_TLS_REJECT_UNAUTHORIZED=0`
 * the runner sets (and that the deployer entrypoint sets in test mode).
 * Using a per-request undici Agent here forced the proxvex production
 * image to ship undici as an explicit dep — but `undici` is built into
 * Node, only the JS module is not always installed in production images,
 * so importing the package broke `proxvex/plain` with
 * `Cannot find package 'undici'`. Native global `fetch` is enough.
 */
export class RemoteStackProvider implements IStackProvider {
  private hubUrl: string;
  private isHttps: boolean;

  private constructor(
    hubUrl: string,
    private getBearerToken?: () => string | undefined,
    private trustedHubCa?: string,
  ) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
    this.isHttps = this.hubUrl.startsWith("https://");
    logger.info("Remote stack provider initialized", {
      hubUrl: this.hubUrl,
      tls: this.isHttps
        ? trustedHubCa
          ? "pinned-ca"
          : "TOFU-insecure"
        : "http",
    });
  }

  static create(
    hubUrl: string,
    getBearerToken?: () => string | undefined,
    trustedHubCa?: string,
  ): RemoteStackProvider {
    return new RemoteStackProvider(hubUrl, getBearerToken, trustedHubCa);
  }

  private async fetchJson<T>(
    path: string,
    method: string = "GET",
    body?: unknown,
  ): Promise<T> {
    const url = `${this.hubUrl}${path}`;
    const headers: Record<string, string> = {};
    const token = this.getBearerToken?.();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const init: RequestInit = {
      method,
      headers,
      // 10s overall ceiling — same as the old curl --max-time.
      signal: AbortSignal.timeout(10000),
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Hub connection failed: ${msg}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Hub returned ${response.status}: ${text.slice(0, 500)}`,
      );
    }
    try {
      return (await response.json()) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid JSON from Hub: ${msg}`);
    }
  }

  async listStacks(stacktype?: string): Promise<IStack[]> {
    const query = stacktype ? `?stacktype=${encodeURIComponent(stacktype)}` : "";
    const response = await this.fetchJson<{ stacks: IStack[] }>(
      `/api/hub/stacks${query}`,
    );
    return response.stacks;
  }

  async getStack(id: string): Promise<IStack | null> {
    try {
      const response = await this.fetchJson<{ stack: IStack }>(
        `/api/hub/stack/${encodeURIComponent(id)}`,
      );
      return response.stack;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("404")) return null;
      throw err;
    }
  }

  async addStack(stack: IStack): Promise<string> {
    const response = await this.fetchJson<{ key: string }>(
      "/api/hub/stacks",
      "POST",
      stack,
    );
    logger.info("Stack created on Hub", { key: response.key });
    return response.key;
  }

  async deleteStack(id: string): Promise<boolean> {
    const response = await this.fetchJson<{ deleted: boolean }>(
      `/api/hub/stack/${encodeURIComponent(id)}`,
      "DELETE",
    );
    if (response.deleted) logger.info("Stack deleted on Hub", { id });
    return response.deleted;
  }

  /**
   * Fetch repositories tarball from the Hub and pipe it to a local directory.
   * Uses curl + tar via shell pipe to keep dependencies minimal.
   */
  async fetchRepositoriesTarball(targetPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.hubUrl}/api/hub/repositories.tar.gz`;
      const args: string[] = ["-s", "-f", "--max-time", "60"];
      if (this.isHttps && !this.trustedHubCa) args.push("-k");
      const token = this.getBearerToken?.();
      if (token) args.push("-H", `Authorization: Bearer ${token}`);
      args.push(url);

      // pipe curl → tar xzf -
      const { spawn } = require("node:child_process") as typeof import("node:child_process");
      const curl = spawn("curl", args);
      const tar = spawn("tar", ["xzf", "-", "-C", targetPath]);
      curl.stdout.pipe(tar.stdin);
      let curlErr = "";
      curl.stderr.on("data", (d) => (curlErr += d.toString()));
      tar.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`tar extraction failed (code ${code})`));
      });
      curl.on("error", (err) =>
        reject(new Error(`curl failed: ${err.message}`)),
      );
      tar.on("error", (err) =>
        reject(new Error(`tar failed: ${err.message}`)),
      );
      curl.on("close", (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`curl exited with ${code}: ${curlErr}`));
        }
      });
    });
  }
}
