import http from "node:http";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "../logger/index.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { ICommand, TaskType, IParameterValue } from "../types.mjs";

type ParamNV = { name: string; value: IParameterValue };

/** Flag the orchestrator sets on the clone-side upgrade request so the
 *  clone's route handler skips orchestration (preventing infinite
 *  clone-spawns-clone recursion). The clone's handler reads this from the
 *  POST body and passes through to the normal upgrade pipeline. */
export const ORCHESTRATED_FLAG = "_orchestrated_via_clone";

/** Filename inside the deployer-CT's /config volume that records "the
 *  clone with this VMID/IP needs to be cleaned up after the upgrade is
 *  done". Written by the orchestrator before triggering the clone-side
 *  upgrade; read by clone-cleanup-service on the new CT's first boot. */
export const CLEANUP_MARKER_FILENAME = ".pending-clone-cleanup.json";

/**
 * Write the marker that tells the new (replaced) deployer-CT to pull the
 * clone's debug bundle and destroy the clone CT once it has booted.
 *
 * The marker lives inside the SOURCE deployer's /config volume. When the
 * clone reconfigures the source, the volume is cloned to the new CT
 * (subvol-NEW-…-config). The marker rides along into the new CT's
 * /config, so the new CT's clone-cleanup-service sees it on first boot.
 */
export function writeCleanupMarker(
  localPath: string,
  marker: {
    cloneVmid: string;
    cloneIp: string;
    restartKey: string;
    veContextKey: string;
  },
): string {
  const markerPath = path.join(localPath, CLEANUP_MARKER_FILENAME);
  const body = {
    clone_vmid: marker.cloneVmid,
    clone_ip: marker.cloneIp,
    restart_key: marker.restartKey,
    ve_context_key: marker.veContextKey,
    started_at: new Date().toISOString(),
  };
  writeFileSync(markerPath, JSON.stringify(body, null, 2));
  logger.info("Clone-cleanup marker written", { markerPath, ...body });
  return markerPath;
}

const logger = createLogger("self-upgrade-orchestrator");

export interface CloneCreationResult {
  cloneVmid: string;
  cloneIp: string;
  cloneHostname: string;
  sourceVmid: string;
  veContextKey: string;
}

/**
 * Self-upgrade orchestrator. The proxvex deployer-CT cannot reliably
 * replace itself in-place (static IP handover races, SSH session death
 * mid-replace). The orchestrator instead clones the deployer into a
 * short-lived "upgrader" CT and uses it as a temporary external deployer
 * that drives the real upgrade against the original.
 *
 * Stage B (current): clone + wait-for-api + one no-op HTTP call. The
 * orchestrator does NOT yet trigger any upgrade through the clone — that
 * arrives in Stage C.
 *
 * Stage C (future): replace the no-op with a real upgrade POST against
 * the clone, generating a deterministic restartKey so the new CT can
 * adopt the clone's debug bundle after Stage D's cleanup service runs.
 */

/**
 * Clone the current deployer-CT into a short-lived temp deployer.
 * Runs `clone-as-temp-deployer.sh` on the PVE host via VeExecution. The
 * script does pct snapshot + clone --full + customization (hostname,
 * static-IP-derived, OIDC strip, SSL strip).
 *
 * Returns the clone's VMID, derived static IP, and new hostname. The
 * clone is created but NOT yet started — caller must `pct start` it.
 */
export async function cloneSelfAsTempDeployer(
  selfVmid: string,
  preferredContextKey?: string,
): Promise<CloneCreationResult> {
  const pm = PersistenceManager.getInstance();
  const contextManager = pm.getContextManager();
  const repositories = pm.getRepositories();

  const scriptContent = repositories.getScript({
    name: "clone-as-temp-deployer.sh",
    scope: "application",
    applicationId: "proxvex",
    category: "create_ct",
  });
  const libraryContent = repositories.getScript({
    name: "upgrade-common.sh",
    scope: "shared",
    category: "root",
  });
  if (!scriptContent || !libraryContent) {
    throw new Error(
      "clone-as-temp-deployer.sh / upgrade-common.sh not found in repositories",
    );
  }

  const veKey = await pickVeContext(preferredContextKey);
  const veContext = contextManager.getVEContextByKey(veKey);
  if (!veContext) throw new Error(`VE context ${veKey} not found`);

  const cmd: ICommand = {
    name: "Clone self as temp deployer",
    execute_on: "ve",
    script: "clone-as-temp-deployer.sh",
    scriptContent,
    libraryContent,
    outputs: [],
  };

  const ve = new VeExecution(
    [cmd],
    [
      { id: "previous_vm_id", value: String(selfVmid) },
      { id: "vm_id_start", value: "400" },
      { id: "searchdomain", value: "" },
    ],
    veContext,
    new Map(),
    undefined,
    determineExecutionMode(),
  );

  await ve.run(null);

  const cloneVmid = String(ve.outputs.get("vm_id") ?? "");
  const cloneIp = String(ve.outputs.get("clone_ip") ?? "");
  const cloneHostname = String(ve.outputs.get("hostname") ?? "");
  if (!cloneVmid || !cloneIp || !cloneHostname) {
    throw new Error(
      `Clone script returned incomplete outputs: vmid=${cloneVmid} ip=${cloneIp} host=${cloneHostname}`,
    );
  }
  logger.info("Clone created", { cloneVmid, cloneIp, cloneHostname, sourceVmid: selfVmid, veKey });
  return { cloneVmid, cloneIp, cloneHostname, sourceVmid: selfVmid, veContextKey: veKey };
}

/**
 * Start the cloned CT on the PVE host (via `pct start`).
 * Idempotent: returns immediately if the CT is already running.
 */
export async function startClone(cloneVmid: string, veContextKey: string): Promise<void> {
  const pm = PersistenceManager.getInstance();
  const veContext = pm.getContextManager().getVEContextByKey(veContextKey);
  if (!veContext) throw new Error(`VE context ${veContextKey} not found`);

  const inlineScript = `#!/bin/sh
set -eu
VMID="{{ clone_vmid }}"
status=$(pct status "$VMID" 2>/dev/null | awk '{print $2}' || echo unknown)
if [ "$status" != "running" ]; then
  pct start "$VMID" >&2
fi
echo '[{"id":"started","value":"true"}]'
`;
  const cmd: ICommand = {
    name: "Start clone",
    execute_on: "ve",
    script: "inline-pct-start.sh",
    scriptContent: inlineScript,
    outputs: [],
  };
  const ve = new VeExecution(
    [cmd],
    [{ id: "clone_vmid", value: String(cloneVmid) }],
    veContext,
    new Map(),
    undefined,
    determineExecutionMode(),
  );
  await ve.run(null);
  logger.info("Clone started", { cloneVmid });
}

/**
 * Poll the clone's HTTP /api/version until it returns 200 or the timeout
 * elapses. Returns the version JSON on success.
 *
 * The orchestrator runs in the deployer-CT, which sits on the same bridge
 * as the clone (host-managed=1 + derived static IP), so the clone's IP is
 * directly reachable without any tunneling.
 */
export async function waitForCloneApi(
  cloneIp: string,
  port = 3080,
  timeoutMs = 90_000,
): Promise<{ version: string; gitHash?: string }> {
  const start = Date.now();
  let lastError = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const body = await httpGetJson<{ version: string; gitHash?: string }>(
        `http://${cloneIp}:${port}/api/version`,
        3000,
      );
      logger.info("Clone API reachable", { cloneIp, version: body.version });
      return body;
    } catch (err: any) {
      lastError = err?.message || String(err);
      await sleep(2000);
    }
  }
  throw new Error(`Clone ${cloneIp}:${port} did not respond within ${timeoutMs}ms (last error: ${lastError})`);
}

/**
 * Stage-B no-op: issue a single GET against the clone and return its
 * response. Used to prove that round-trips work end-to-end.
 */
export async function triggerNoOpOnClone(cloneIp: string, port = 3080): Promise<unknown> {
  const body = await httpGetJson<unknown>(`http://${cloneIp}:${port}/api/applications`, 5000);
  return body;
}

/**
 * Stage-C real trigger: POST the original upgrade/reconfigure request to
 * the clone's VeConfiguration endpoint. The clone runs the regular
 * pipeline (skipping orchestration thanks to the `_orchestrated_via_clone`
 * flag) and drives the replace against `previous_vm_id` = the deployer
 * that is being upgraded.
 *
 * Returns the restart key the clone assigned to its task — the orchestrator
 * can poll it via /api/ve/execute against the clone (left to the caller).
 */
export async function triggerUpgradeViaClone(
  cloneIp: string,
  veContextKey: string,
  application: string,
  task: TaskType,
  params: ParamNV[],
  previousVmid: string,
  selectedAddons: string[],
  port = 3080,
  timeoutMs = 30_000,
): Promise<{ restartKey: string; cloneStatus: number }> {
  // Ensure previous_vm_id is in the params so the clone's pipeline knows
  // which CT to replace. The orchestrator's caller may or may not have
  // included it — be defensive.
  const paramsWithPrev = params.filter((p) => p.name !== "previous_vm_id");
  paramsWithPrev.push({ name: "previous_vm_id", value: String(previousVmid) });

  const body = {
    task,
    params: paramsWithPrev,
    selectedAddons,
    [ORCHESTRATED_FLAG]: true,
  };
  // Route shape: /api/:veContext/ve-configuration/:application (see
  // ApiUri.VeConfiguration in types.mts).
  const url = `http://${cloneIp}:${port}/api/${encodeURIComponent(veContextKey)}/ve-configuration/${encodeURIComponent(application)}`;
  logger.info("Triggering clone-side upgrade", { url, task, previousVmid, selectedAddons });
  const response = await httpPostJson<{ restartKey?: string }>(url, body, timeoutMs);
  if (!response.body?.restartKey) {
    throw new Error(
      `Clone returned no restartKey (status=${response.status}, body=${JSON.stringify(response.body).slice(0, 200)})`,
    );
  }
  return { restartKey: response.body.restartKey, cloneStatus: response.status };
}

/**
 * Detect whether the current request is a deployer self-upgrade: the
 * deployer-instance marker on `previousVmid` AND the request was not
 * already routed through a clone (which would loop infinitely).
 *
 * Returns true only when:
 *   - application is "proxvex"
 *   - task is "upgrade" or "reconfigure"
 *   - previousVmid carries the deployer-instance marker on the PVE host
 *   - the request body does NOT carry the ORCHESTRATED_FLAG
 */
export async function shouldOrchestrateSelfUpgrade(
  application: string,
  task: TaskType,
  previousVmid: string | undefined,
  requestBody: any,
  veContextKey: string,
): Promise<boolean> {
  if (application !== "proxvex") return false;
  if (task !== "upgrade" && task !== "reconfigure") return false;
  if (!previousVmid) return false;
  if (requestBody && requestBody[ORCHESTRATED_FLAG] === true) return false;

  // Probe via SSH whether the previous CT has the deployer-instance marker.
  // Cheaper than a full VeExecution roundtrip; reuses the existing SSH
  // master connection that VeExecution would establish anyway.
  const pm = PersistenceManager.getInstance();
  const veContext = pm.getContextManager().getVEContextByKey(veContextKey);
  if (!veContext) return false;

  const inlineScript = `#!/bin/sh
set -eu
VMID="{{ previous_vm_id }}"
if pct config "$VMID" 2>/dev/null | grep -qa deployer-instance; then
  echo '[{"id":"is_deployer","value":"true"}]'
else
  echo '[{"id":"is_deployer","value":"false"}]'
fi
`;
  const cmd: ICommand = {
    name: "Detect deployer-instance marker",
    execute_on: "ve",
    script: "inline-is-deployer.sh",
    scriptContent: inlineScript,
    outputs: [],
  };
  const ve = new VeExecution(
    [cmd],
    [{ id: "previous_vm_id", value: String(previousVmid) }],
    veContext,
    new Map(),
    undefined,
    determineExecutionMode(),
  );
  try {
    await ve.run(null);
  } catch (err: any) {
    logger.warn("Could not probe deployer marker — proceeding without orchestration", {
      previousVmid,
      error: err?.message,
    });
    return false;
  }
  return String(ve.outputs.get("is_deployer") ?? "false") === "true";
}

// ── helpers ──────────────────────────────────────────────────────────────

async function pickVeContext(preferred: string | undefined): Promise<string> {
  const pm = PersistenceManager.getInstance();
  const cm = pm.getContextManager();
  const keys = Array.from(cm.keys()).filter((k) => k.startsWith("ve_"));
  if (preferred && keys.includes(preferred)) return preferred;
  if (keys.length === 0) throw new Error("No VE contexts configured");
  return keys[0]!;
}

function httpPostJson<T>(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 3080,
        path: u.pathname + u.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve({ status: res.statusCode ?? 0, body: raw ? (JSON.parse(raw) as T) : ({} as T) });
          } catch (err: any) {
            reject(new Error(`Invalid JSON from ${url}: ${err?.message} (raw=${raw.slice(0, 200)})`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout connecting to ${url}`)));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function httpGetJson<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")) as T);
        } catch (err: any) {
          reject(new Error(`Invalid JSON from ${url}: ${err?.message}`));
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timeout connecting to ${url}`)));
    req.on("error", reject);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
