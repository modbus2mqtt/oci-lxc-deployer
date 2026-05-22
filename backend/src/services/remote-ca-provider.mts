import https from "node:https";
import http from "node:http";
import { ICaInfoResponse } from "../types.mjs";
import { ICaProvider } from "./ca-provider.mjs";
import { normalizeExtraSans as normalizeSans } from "./certificate-authority-service.mjs";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("remote-ca-provider");

/**
 * Remote CA provider: delegates CA operations to the Hub deployer via HTTP(S).
 *
 * Auth: If a bearer token getter is provided and returns a token, it's sent
 * as `Authorization: Bearer <token>`. Otherwise the request goes unauthenticated
 * (Hub without OIDC accepts this).
 *
 * TLS trust: During TOFU (Trust On First Use) the HTTPS agent accepts any
 * certificate. Once a trusted CA PEM is known, it is pinned via `ca:`. For
 * plain http:// hub URLs TLS is not used.
 */
export class RemoteCaProvider implements ICaProvider {
  private hubUrl: string;
  private agent: https.Agent | http.Agent;
  private isHttps: boolean;

  constructor(
    hubUrl: string,
    private getBearerToken?: () => string | undefined,
    trustedHubCa?: string,
  ) {
    this.hubUrl = hubUrl.replace(/\/$/, "");
    this.isHttps = this.hubUrl.startsWith("https://");
    if (this.isHttps) {
      this.agent = new https.Agent(
        trustedHubCa
          ? { ca: trustedHubCa, rejectUnauthorized: true }
          : { rejectUnauthorized: false },
      );
    } else {
      this.agent = new http.Agent();
    }
    logger.info("Remote CA provider initialized", {
      hubUrl: this.hubUrl,
      tls: this.isHttps ? (trustedHubCa ? "pinned-ca" : "TOFU-insecure") : "http",
    });
  }

  private async fetchJson<T>(
    path: string,
    method: string = "GET",
    body?: unknown,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.hubUrl);
      const headers: Record<string, string> = {};
      if (body) headers["Content-Type"] = "application/json";
      const token = this.getBearerToken?.();
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const options: https.RequestOptions = {
        method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        agent: this.agent,
        headers,
      };

      const lib = this.isHttps ? https : http;
      const req = lib.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`Hub API error ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Invalid JSON from Hub: ${data}`));
          }
        });
      });

      req.on("error", (err) =>
        reject(new Error(`Hub connection failed: ${err.message}`)),
      );
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  // --- CA lifecycle (delegated to Hub) ---

  async ensureCA(_veContextKey: string): Promise<{ key: string; cert: string }> {
    const cert = await this.getCACert();
    if (!cert) throw new Error("Hub CA not available — is the Hub reachable?");
    return { key: "", cert };
  }

  async getCA(_veContextKey: string): Promise<{ key: string; cert: string } | null> {
    const cert = await this.getCACert();
    if (!cert) return null;
    return { key: "", cert };
  }

  async hasCA(_veContextKey: string): Promise<boolean> {
    return (await this.getCACert()) !== null;
  }

  async generateCA(_veContextKey: string): Promise<{ key: string; cert: string }> {
    throw new Error("Cannot generate CA on Spoke — CA is managed by Hub");
  }

  async setCA(_veContextKey: string, _key: string, _cert: string): Promise<void> {
    throw new Error("Cannot set CA on Spoke — CA is managed by Hub");
  }

  async getCaInfo(veContextKey: string): Promise<ICaInfoResponse> {
    return { exists: await this.hasCA(veContextKey) };
  }

  async validateCaPem(_key: string, _cert: string): Promise<{ valid: boolean; subject?: string; error?: string }> {
    throw new Error("Cannot validate CA PEM on Spoke — CA is managed by Hub");
  }

  // --- Domain suffix (stored locally for now) ---

  private projectDomainSuffix: string = ".local";

  async getDomainSuffix(_veContextKey: string): Promise<string> {
    return this.projectDomainSuffix;
  }

  async setDomainSuffix(_veContextKey: string, suffix: string): Promise<void> {
    this.projectDomainSuffix = suffix;
  }

  // --- Shared volume path (stored locally) ---

  private sharedVolpath: string | null = null;

  async getSharedVolpath(_veContextKey: string): Promise<string | null> {
    return this.sharedVolpath;
  }

  async setSharedVolpath(_veContextKey: string, path: string): Promise<void> {
    this.sharedVolpath = path;
  }

  // --- Server certificates (signed by Hub) ---

  /** Cache of server certs keyed by hostname+SAN-set so SAN changes invalidate. */
  private serverCertCache = new Map<string, { key: string; cert: string }>();

  private cacheKey(hostname: string, sans: string[]): string {
    return sans.length === 0 ? hostname : `${hostname}|${sans.join(",")}`;
  }

  async generateSelfSignedCert(veContextKey: string, hostname?: string, extraSans?: string[]): Promise<{ key: string; cert: string }> {
    return this.ensureServerCert(veContextKey, hostname, extraSans);
  }

  async ensureServerCert(_veContextKey: string, hostname?: string, extraSans?: string[]): Promise<{ key: string; cert: string }> {
    const host = hostname || "localhost";
    const sans = normalizeSans(extraSans);
    const key = this.cacheKey(host, sans);
    const cached = this.serverCertCache.get(key);
    if (cached) return cached;

    const body: { hostname: string; extraSans?: string[] } = { hostname: host };
    if (sans.length > 0) body.extraSans = sans;
    let parsed: { cert?: string; key?: string };
    try {
      parsed = await this.fetchJson<{ cert?: string; key?: string }>(
        "/api/hub/ca/sign",
        "POST",
        body,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Hub /api/hub/ca/sign failed: ${msg}`);
    }
    if (!parsed.cert || !parsed.key) {
      throw new Error(`Hub /api/hub/ca/sign returned empty cert/key for ${host}`);
    }
    const signed = { cert: parsed.cert, key: parsed.key };
    this.serverCertCache.set(key, signed);
    logger.info("Server cert signed by Hub", { hostname: host, extraSans: sans });
    return signed;
  }

  // --- Client certificates (signed by Hub) ---

  /** Cache of client certs keyed by CN — kept separate from serverCertCache. */
  private clientCertCache = new Map<string, { key: string; cert: string }>();

  async signClientCert(_veContextKey: string, cn: string): Promise<{ key: string; cert: string }> {
    const cached = this.clientCertCache.get(cn);
    if (cached) return cached;

    // Async Hub call via fetchJson. The Hub distinguishes client from server
    // signing via the `mode` field.
    let parsed: { cert?: string; key?: string };
    try {
      parsed = await this.fetchJson<{ cert?: string; key?: string }>(
        "/api/hub/ca/sign",
        "POST",
        { hostname: cn, mode: "client" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Hub /api/hub/ca/sign (client) failed: ${msg}`);
    }
    if (!parsed.cert || !parsed.key) {
      throw new Error(`Hub /api/hub/ca/sign (client) returned empty cert/key for ${cn}`);
    }
    const signed = { cert: parsed.cert, key: parsed.key };
    this.clientCertCache.set(cn, signed);
    logger.info("Client cert signed by Hub", { cn });
    return signed;
  }

  // --- Internal helpers ---

  private cachedCaCert: string | null = null;

  /**
   * Public CA cert is fetched from the Hub. Cached after first successful
   * fetch; subsequent calls within a process never hit the Hub again.
   */
  private async getCACert(): Promise<string | null> {
    if (this.cachedCaCert) return this.cachedCaCert;
    try {
      const resp = await this.fetchJson<{ cert?: string }>(
        "/api/hub/ca/cert",
      );
      if (resp.cert) {
        this.cachedCaCert = resp.cert;
        return resp.cert;
      }
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("Hub /api/hub/ca/cert fetch failed", { error: msg });
      return null;
    }
  }

  /**
   * Warm the cached CA cert — called during spoke-sync or on demand.
   */
  async warmCaCacheAsync(): Promise<void> {
    const resp = await this.fetchJson<{ cert: string }>("/api/hub/ca/cert");
    this.cachedCaCert = resp.cert;
  }

  /**
   * Async method to sign a certificate via Hub API.
   */
  async signCertificateAsync(hostname: string): Promise<{ key: string; cert: string }> {
    const result = await this.fetchJson<{ cert: string; key: string }>(
      "/api/hub/ca/sign",
      "POST",
      { hostname },
    );
    logger.info("Certificate signed by Hub", { hostname });
    return result;
  }
}
