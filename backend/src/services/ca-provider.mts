import { ICaInfoResponse } from "../types.mjs";

/**
 * Certificate Authority provider interface.
 * Hub mode: local operations (CertificateAuthorityService).
 * Spoke mode: delegates to Hub API (RemoteCaProvider).
 *
 * All methods are async because RemoteCaProvider performs network I/O.
 * The previous synchronous interface forced `spawnSync("curl")` to block
 * the Node event loop while waiting on the Hub, dropping concurrent CLI
 * connections to the Spoke during cert-signing bursts.
 */
export interface ICaProvider {
  // CA lifecycle
  ensureCA(veContextKey: string): Promise<{ key: string; cert: string }>;
  getCA(veContextKey: string): Promise<{ key: string; cert: string } | null>;
  hasCA(veContextKey: string): Promise<boolean>;
  generateCA(veContextKey: string): Promise<{ key: string; cert: string }>;
  setCA(veContextKey: string, key: string, cert: string): Promise<void>;
  getCaInfo(veContextKey: string): Promise<ICaInfoResponse>;
  validateCaPem(key: string, cert: string): Promise<{ valid: boolean; subject?: string; error?: string }>;

  // Domain suffix (per VE context)
  getDomainSuffix(veContextKey: string): Promise<string>;
  setDomainSuffix(veContextKey: string, suffix: string): Promise<void>;

  // Shared volume path (per VE context)
  getSharedVolpath(veContextKey: string): Promise<string | null>;
  setSharedVolpath(veContextKey: string, path: string): Promise<void>;

  // Server certificates
  //
  // Server certs are NOT persisted by the provider. The container-side
  // `conf-generate-certificates.sh` keeps the on-disk cert when its identity
  // (CN+SAN) matches the freshly-signed candidate, so the disk is the source
  // of truth. The Hub provider always signs fresh; the Spoke provider uses
  // an in-process cache to coalesce redundant Hub round-trips within one
  // Reconfigure flow, but does not persist anything across restarts.
  generateSelfSignedCert(veContextKey: string, hostname?: string, extraSans?: string[]): Promise<{ key: string; cert: string }>;
  ensureServerCert(veContextKey: string, hostname?: string, extraSans?: string[]): Promise<{ key: string; cert: string }>;

  // Client certificates (mTLS user identities)
  //
  // Issues a CA-signed client certificate for a single Common Name. CN-only
  // (no SAN), `basicConstraints=CA:FALSE`, `extendedKeyUsage=clientAuth`.
  // Like server certs, nothing is persisted by the provider — the
  // container-side `conf-generate-mtls-certs.sh` keeps the on-disk cert when
  // its identity matches. Hub signs locally; Spoke delegates to the Hub API.
  signClientCert(veContextKey: string, cn: string): Promise<{ key: string; cert: string }>;
}
