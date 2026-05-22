import express from "express";
import { createLogger } from "../logger/index.mjs";
import {
  cloneSelfAsTempDeployer,
  startClone,
  waitForCloneApi,
  triggerNoOpOnClone,
} from "../services/self-upgrade-orchestrator.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";

const logger = createLogger("self-upgrade-routes");

/**
 * Temporary Stage-B test endpoint for the self-upgrade-via-clone orchestrator.
 *
 *   POST /api/proxvex/self-upgrade-orchestrator-test
 *     body: { deployer_vmid: "300" [, ve_context_key: "ve_pve…"] }
 *
 * Runs the Stage-A clone pipeline through the orchestrator, starts the
 * clone, waits for its HTTP API, fires a single no-op GET, and returns
 * the round-trip outcome. The clone is left running so it can be inspected
 * — manual cleanup via `pct stop $clone_vmid && pct destroy $clone_vmid`
 * (or the host-stop-and-destroy-clone-deployer.sh script).
 *
 * This route exists only for Stage B; Stage C replaces it with the real
 * orchestrator-trigger inside the `upgrade`/`reconfigure` route handlers
 * (after `currentExecutableIsSelf()` returns true).
 */
export function registerSelfUpgradeRoutes(app: express.Application): void {
  app.post(
    "/api/proxvex/self-upgrade-orchestrator-test",
    express.json(),
    async (req, res) => {
      const startedAt = Date.now();
      const body = (req.body ?? {}) as {
        deployer_vmid?: string;
        ve_context_key?: string;
      };
      const deployerVmid = body.deployer_vmid;
      if (!deployerVmid || !/^\d+$/.test(deployerVmid)) {
        res
          .status(400)
          .json({ error: "deployer_vmid (string of digits) is required in the request body" });
        return;
      }

      try {
        logger.info("Stage-B test: cloning deployer", { deployerVmid });
        const clone = await cloneSelfAsTempDeployer(deployerVmid, body.ve_context_key);

        logger.info("Stage-B test: starting clone", { clone });
        await startClone(clone.cloneVmid, clone.veContextKey);

        logger.info("Stage-B test: waiting for clone API", { cloneIp: clone.cloneIp });
        const version = await waitForCloneApi(clone.cloneIp);

        logger.info("Stage-B test: firing no-op call", { cloneIp: clone.cloneIp });
        const noopResult = await triggerNoOpOnClone(clone.cloneIp);

        const durationMs = Date.now() - startedAt;
        res.status(200).json({
          status: "ok",
          clone_vmid: clone.cloneVmid,
          clone_ip: clone.cloneIp,
          clone_hostname: clone.cloneHostname,
          source_vmid: clone.sourceVmid,
          ve_context_key: clone.veContextKey,
          clone_version: version,
          noop_result_truncated:
            typeof noopResult === "object" && noopResult !== null
              ? `<${Array.isArray(noopResult) ? noopResult.length : Object.keys(noopResult as object).length} items>`
              : String(noopResult),
          duration_ms: durationMs,
          cleanup_hint: `ssh root@<pve> 'pct shutdown ${clone.cloneVmid} --timeout 15 --forceStop 1; pct destroy ${clone.cloneVmid} --purge'`,
        });
      } catch (err: any) {
        logger.error("Stage-B test failed", { error: err?.message, stack: err?.stack });
        sendErrorResponse(res, err);
      }
    },
  );
}
