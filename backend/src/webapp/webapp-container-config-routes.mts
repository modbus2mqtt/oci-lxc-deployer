import express from "express";
import { ApiUri } from "@src/types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";
import { getContainerConfig } from "../services/container-config-service.mjs";
import { sendErrorResponse } from "./webapp-error-utils.mjs";

export function registerContainerConfigRoutes(
  app: express.Application,
  storageContext: ContextManager,
): void {
  const pm = PersistenceManager.getInstance();

  app.get(ApiUri.ContainerConfig, async (req, res) => {
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

      const vmId = parseInt(req.params.vmId, 10);
      if (isNaN(vmId)) {
        res.status(400).json({ error: "Invalid vmId" });
        return;
      }

      const parsed = await getContainerConfig(pm, veContext, vmId);
      res.status(200).json(parsed);
    } catch (err: any) {
      sendErrorResponse(res, err);
    }
  });
}
