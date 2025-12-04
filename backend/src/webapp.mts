#!/usr/bin/env node
import express from "express";
import { TaskType, ISsh, ApiUri } from "@src/types.mjs";
import http from "http";
import path from "path";
import { fileURLToPath } from "node:url";
import { StorageContext } from "./storagecontext.mjs";
import { IVEContext } from "./backend-types.mjs";
export class VEWebApp {
  app: express.Application;
  public httpServer: http.Server;

  constructor(storageContext: StorageContext) {
    this.app = express();
    this.httpServer = http.createServer(this.app);
    // No socket.io needed anymore

    // SSH config API
    this.app.get(ApiUri.SshConfigs, (req, res) => {
      try {
        const sshs: ISsh[] = storageContext
          .keys()
          .filter((key) => key.startsWith("ve_"))
          .map((key) => {
            return storageContext.get<IVEContext>(key) as any;
          });
        res.json(sshs);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post(ApiUri.SshConfig, express.json(), (req, res) => {
      const ssh: ISsh = req.body;
      if (
        !ssh ||
        typeof ssh.host !== "string" ||
        typeof ssh.port !== "number"
      ) {
        res.status(400).json({
          error:
            "Invalid SSH config. Must provide host (string) and port (number).",
        });
        return;
      }
      try {
        storageContext.setVEContext({
          host: ssh.host,
          port: ssh.port,
          current: ssh.current || false
        } as IVEContext);
        res.json({ success: true }).status(200);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get(
      "/api/getUnresolvedParameters/:application/:task",
      (req, res) => {
        const { application, task } = req.params;
        try {
          const templateProcessor = storageContext.getTemplateProcessor();
          const loaded = templateProcessor.loadApplication(
            application,
            task as TaskType,
          );
          const unresolvedParameters =
            templateProcessor.getUnresolvedParameters(
              loaded.parameters,
              loaded.resolvedParams,
            );
          res
            .json({
              unresolvedParameters: unresolvedParameters,
            })
            .status(200);
        } catch (err: any) {
          res
            .status(400)
            .json({ error: err.message, errors: err.errors || [] });
        }
      },
    );

    this.app.get("/api/applications", (req, res) => {
      try {
        const applications = storageContext.listApplications();

        res.json(applications).status(200);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
  }
}

// If run directly, start the server
if (
  import.meta.url === process.argv[1] ||
  import.meta.url === `file://${process.argv[1]}`
) {
  const filename = fileURLToPath(import.meta.url);
  const dirname = path.dirname(filename);
  const jsonTestPath = path.join(dirname, "../local/json");
  StorageContext.setInstance(jsonTestPath);
  const webApp = new VEWebApp(StorageContext.getInstance());
  const port = process.env.PORT || 3000;
  webApp.httpServer.listen(port, () => {
    console.log(`ProxmoxWebApp listening on port ${port}`);
  });
}
