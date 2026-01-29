import express from "express";
import { ApiUri, IInstallationsResponse, ICommand } from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
import { serializeError } from "./webapp-error-utils.mjs";



export function registerInstallationsRoutes(
  app: express.Application,
  storageContext: ContextManager,
): void {
  app.get(ApiUri.Installations, async (req, res) => {
    try {
      const veContextKey = String(req.params.veContext || "").trim();
      if (!veContextKey) {
        res.status(400).json({ error: "Missing veContext" });
        return;
      }
      const veContext = storageContext.getVEContextByKey(veContextKey);
      if (!veContext) {
        res.status(404).json({ error: "VE context not found" });
        return;
      }

      const repositories = PersistenceManager.getInstance().getRepositories();
      const scriptContent = repositories.getScript({
        name: "list-managed-oci-containers.py",
        scope: "shared",
      });
      if (!scriptContent) {
        res.status(500).json({
          error:
            "list-managed-oci-containers.py not found (expected in local/shared/scripts or json/shared/scripts)",
        });
        return;
      }

      const cmd: ICommand = {
        name: "List Managed OCI Containers",
        execute_on: "ve",
        script: "list-managed-oci-containers.py",
        scriptContent,
        outputs: ["containers"],
      };

      const ve = new VeExecution(
        [cmd],
        [],
        veContext,
        new Map(),
        undefined,
        determineExecutionMode(),
      );
      await ve.run(null);
      const containersRaw = ve.outputs.get("containers");
      const parsed =
        typeof containersRaw === "string" && containersRaw.trim().length > 0
          ? JSON.parse(containersRaw)
          : [];
      const payload: IInstallationsResponse = Array.isArray(parsed)
        ? parsed
        : [];
      res.status(200).json(payload);
    } catch (err: any) {
      const serializedError = serializeError(err);
      res.status(500).json({
        error: err instanceof Error ? err.message : String(err),
        serializedError: serializedError,
      });
    }
  });
}
