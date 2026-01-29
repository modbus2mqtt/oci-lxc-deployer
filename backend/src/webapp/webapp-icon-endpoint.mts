import express from "express";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";

export class WebAppIconEndpoint {
  constructor(private app: express.Application) {}

  init(): void {
    this.app.get("/icons/:applicationId.:ext", (req, res) => {
      try {
        const applicationId = String(req.params.applicationId || "").trim();
        const ext = String(req.params.ext || "").toLowerCase();
        if (!applicationId) {
          res.status(400).json({ error: "Missing applicationId" });
          return;
        }
        if (ext !== "png" && ext !== "svg") {
          res.status(400).json({ error: "Unsupported icon extension" });
          return;
        }

        const pm = PersistenceManager.getInstance();
        const icon = pm.getApplicationService().readApplicationIcon(applicationId);
        if (!icon) {
          res.status(404).json({ error: "Icon not found" });
          return;
        }

        const expectedType = ext === "svg" ? "image/svg+xml" : "image/png";
        if (icon.iconType !== expectedType) {
          res.status(404).json({ error: "Icon not found" });
          return;
        }

        const buffer = Buffer.from(icon.iconContent, "base64");
        res.setHeader("Content-Type", icon.iconType);
        res.setHeader("Cache-Control", "public, max-age=3600");
        res.status(200).send(buffer);
      } catch (err: any) {
        res
          .status(500)
          .json({ error: err instanceof Error ? err.message : String(err) });
      }
    });
  }
}
