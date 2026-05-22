import { existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { createLogger } from "../logger/index.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { ICommand } from "../types.mjs";

const logger = createLogger("clone-cleanup");

interface CloneCleanupMarker {
  clone_vmid?: string;
  clone_ip?: string;
  restart_key?: string;
  ve_context_key?: string;
  started_at?: string;
}

/**
 * Stage-D finalizer: after a self-upgrade-via-clone the new (replaced)
 * deployer-CT boots with `.pending-clone-cleanup.json` in its /config
 * volume — written by the orchestrator on the source side before
 * triggering the clone-side upgrade. This finalizer reads the marker,
 * pulls the clone's debug bundle into the local collector under the same
 * restart key (so the bundle survives the source-CT destroy), then
 * shuts down + destroys the clone CT and deletes the marker.
 *
 * Idempotent: if the marker is missing, return immediately. On any
 * failure the marker stays so the next boot retries. That trades
 * "transient PVE unreachable" against "stuck zombie clone CT".
 */
export async function finalizeCloneCleanupIfPending(localPath: string): Promise<void> {
  const markerPath = path.join(localPath, ".pending-clone-cleanup.json");
  if (!existsSync(markerPath)) return;

  let marker: CloneCleanupMarker;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf-8")) as CloneCleanupMarker;
  } catch (err: any) {
    logger.warn("Clone-cleanup marker found but could not be parsed", {
      markerPath,
      error: err?.message,
    });
    return;
  }

  const { clone_vmid: cloneVmid, clone_ip: cloneIp, restart_key: restartKey, ve_context_key: veKey } = marker;
  if (!cloneVmid || !cloneIp || !veKey) {
    logger.warn("Clone-cleanup marker has missing fields — refusing to act", { marker });
    return;
  }

  logger.info("Clone-cleanup starting", { cloneVmid, cloneIp, restartKey, veKey });

  // 1. Pull the clone's debug bundle (best-effort: a missing bundle is
  // not fatal — we still want to destroy the clone so the user does not
  // end up with a zombie helper CT).
  if (restartKey) {
    try {
      await pullAndAdoptBundle(cloneIp, restartKey);
    } catch (err: any) {
      logger.warn("Clone bundle pull failed — continuing with cleanup", {
        cloneIp,
        restartKey,
        error: err?.message,
      });
    }
    // Also pull the clone's execution messages and inject them into this
    // CT's message-manager under the same restartKey. Without this the CLI
    // / livetest runner polling /api/<ve>/ve/execute on this CT after the
    // replacement would see an empty group and time out — even though the
    // task itself completed on the clone.
    //
    // Critical: wait for the clone to mark the task `finished` BEFORE
    // pulling. The clone's task finishes only after post_start on the new
    // CT (us) is done — so when this code runs at boot, the clone may
    // still be running. Polling for finished blocks until the clone
    // reports completion, then captures the final messages including the
    // exitCode that the CLI needs to decide success/failure.
    try {
      await waitForCloneTaskFinished(cloneIp, veKey, restartKey);
      await pullAndAdoptMessages(cloneIp, veKey, restartKey);
    } catch (err: any) {
      logger.warn("Clone message pull failed — runner may not see finished status", {
        cloneIp,
        restartKey,
        error: err?.message,
      });
    }
  }

  // 2. Stop + destroy the clone via the maintenance script.
  try {
    await destroyClone(cloneVmid, veKey);
  } catch (err: any) {
    logger.error("Clone destroy failed — marker kept for retry on next boot", {
      cloneVmid,
      error: err?.message,
    });
    return;
  }

  // 3. Drop the marker; cleanup is complete.
  try {
    unlinkSync(markerPath);
    logger.info("Clone-cleanup complete; marker removed", { markerPath });
  } catch (err: any) {
    logger.warn("Failed to remove clone-cleanup marker", { markerPath, error: err?.message });
  }
}

async function pullAndAdoptBundle(cloneIp: string, restartKey: string): Promise<void> {
  const port = 3080;
  // Fetch the manifest.
  const manifest = await httpGetJson<{ files?: string[] }>(
    `http://${cloneIp}:${port}/api/ve/debug/${encodeURIComponent(restartKey)}`,
    5000,
  );
  if (!manifest?.files || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    logger.info("Clone reports no debug-bundle files — nothing to adopt", { cloneIp, restartKey });
    return;
  }

  // Fetch each file in parallel (bounded — node http is fine with small
  // bundles; production bundles are typically <1MB total).
  const fileMap = new Map<string, string>();
  await Promise.all(
    manifest.files.map(async (relPath) => {
      const url = `http://${cloneIp}:${port}/api/ve/debug/${encodeURIComponent(restartKey)}/${relPath}`;
      const content = await httpGetText(url, 5000);
      fileMap.set(relPath, content);
    }),
  );

  const { getActiveDebugCollector } = await import("../webapp/webapp-debug-collector.mjs");
  const collector = getActiveDebugCollector();
  if (!collector) {
    logger.warn("Active debug collector not available — bundle pulled but not adopted; route would return 404", {
      restartKey,
      fileCount: fileMap.size,
    });
    return;
  }
  collector.injectBundle(restartKey, fileMap);
  logger.info("Clone bundle adopted into local collector", {
    cloneIp,
    restartKey,
    fileCount: fileMap.size,
  });
}

async function waitForCloneTaskFinished(
  cloneIp: string,
  veContextKey: string,
  restartKey: string,
  timeoutMs = 8 * 60_000,
  pollIntervalMs = 3_000,
): Promise<void> {
  const port = 3080;
  const url = `http://${cloneIp}:${port}/api/${encodeURIComponent(veContextKey)}/ve/execute?restartKey=${encodeURIComponent(restartKey)}`;
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;
  while (Date.now() < deadline) {
    try {
      const groups = await httpGetJson<Array<{
        restartKey?: string;
        messages?: Array<{ finished?: boolean }>;
      }>>(url, 5_000);
      const group = (groups ?? []).find((g) => g.restartKey === restartKey);
      const lastMsg = group?.messages?.[group.messages.length - 1];
      if (lastMsg?.finished === true) {
        logger.info("Clone task reports finished — proceeding to message pull", {
          cloneIp,
          restartKey,
          messageCount: group?.messages?.length ?? 0,
        });
        return;
      }
      consecutiveErrors = 0;
    } catch (err: any) {
      consecutiveErrors++;
      // Tolerate transient errors — the clone may be busy on a long-running
      // pct command, where the HTTP server briefly stops accepting new
      // connections. Hard-fail only on sustained outages (assume clone
      // crashed mid-task).
      if (consecutiveErrors > 30) {
        throw new Error(`Clone ${cloneIp} unreachable for ${consecutiveErrors * pollIntervalMs / 1000}s — giving up wait-for-finished (${err?.message ?? String(err)})`);
      }
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Clone task did not report finished within ${timeoutMs / 1000}s — pulling messages anyway may give partial results`);
}

async function pullAndAdoptMessages(
  cloneIp: string,
  veContextKey: string,
  restartKey: string,
): Promise<void> {
  const port = 3080;
  // GET /api/<veCtx>/ve/execute?restartKey=<key> returns an array of
  // ISingleExecuteMessagesResponse groups. We filter to the matching key.
  const url = `http://${cloneIp}:${port}/api/${encodeURIComponent(veContextKey)}/ve/execute?restartKey=${encodeURIComponent(restartKey)}`;
  const groups = await httpGetJson<Array<{
    application?: string;
    task?: string;
    restartKey?: string;
    messages?: unknown[];
  }>>(url, 10_000);
  const group = (groups ?? []).find((g) => g.restartKey === restartKey);
  if (!group || !group.application || !group.task || !Array.isArray(group.messages) || group.messages.length === 0) {
    logger.info("Clone reports no messages for this restartKey — nothing to inject", {
      cloneIp,
      restartKey,
      hasGroup: !!group,
      messageCount: group?.messages?.length ?? 0,
    });
    return;
  }
  const { getActiveMessageManager } = await import("../webapp/webapp-ve-message-manager.mjs");
  const mm = getActiveMessageManager();
  if (!mm) {
    logger.warn("Active message manager not available — messages pulled but not adopted; runner polling will see empty group", {
      restartKey,
      messageCount: group.messages.length,
    });
    return;
  }
  mm.injectMessages(group.application, group.task, restartKey, group.messages as never);
  logger.info("Clone messages adopted into local manager", {
    cloneIp,
    restartKey,
    application: group.application,
    task: group.task,
    messageCount: group.messages.length,
  });
}

async function destroyClone(cloneVmid: string, veContextKey: string): Promise<void> {
  const pm = PersistenceManager.getInstance();
  const veContext = pm.getContextManager().getVEContextByKey(veContextKey);
  if (!veContext) throw new Error(`VE context ${veContextKey} not found`);

  const scriptContent = pm.getRepositories().getScript({
    name: "host-stop-and-destroy-clone-deployer.sh",
    scope: "shared",
    category: "maintenance",
  });
  if (!scriptContent) {
    throw new Error("host-stop-and-destroy-clone-deployer.sh not found in repositories");
  }

  const cmd: ICommand = {
    name: "Stop and destroy clone deployer",
    execute_on: "ve",
    script: "host-stop-and-destroy-clone-deployer.sh",
    scriptContent,
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
  logger.info("Clone destroyed", { cloneVmid, ve_context: veContextKey });
}

// ── helpers ──────────────────────────────────────────────────────────────

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

function httpGetText(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${url}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });
    });
    req.on("timeout", () => req.destroy(new Error(`Timeout connecting to ${url}`)));
    req.on("error", reject);
  });
}
