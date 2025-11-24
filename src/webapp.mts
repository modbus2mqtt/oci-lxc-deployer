#!/usr/bin/env node
import express from "express";
import { ProxmoxConfiguration } from "@src/proxmoxconfiguration.mjs";
import { TaskType, ISsh, IProxmoxExecuteMessage } from "@src/types.mjs";
import { ProxmoxExecution } from "@src/proxmox-execution.mjs";
import { existsSync } from "fs";
import http from "http";
import path from "path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export class ProxmoxWebApp {
  app: express.Application;
  public httpServer: http.Server;
  messages: IProxmoxExecuteMessage[] = [];

  constructor(schemaPath: string, jsonPath: string, localJsonPath: string) {
    this.app = express();
    this.httpServer = http.createServer(this.app);
    // No socket.io needed anymore

    // No socket.io initialization anymore
    // POST /api/proxmox-configuration/:application/:task
    this.app.post(
      "/api/proxmox-configuration/:application/:task",
      express.json(),
      async (req, res) => {
        const { application, task } = req.params;
        const params = req.body; // Array of { name, value }
        if (!Array.isArray(params)) {
          return res
            .status(400)
            .json({ success: false, error: "Invalid parameters" });
        }
        try {
          // 1. Save configuration in local/<application>.config.json
          const localDir = path.join(process.cwd(), "local");
          if (!fs.existsSync(localDir)) fs.mkdirSync(localDir);
          const configPath = path.join(localDir, `${application}.config.json`);
          fs.writeFileSync(
            configPath,
            JSON.stringify(params, null, 2),
            "utf-8",
          );

          // 2. Load application (provides commands)
          const config = new ProxmoxConfiguration(
            schemaPath,
            jsonPath,
            localJsonPath,
          );
          config.loadApplication(application, task as TaskType);
          const commands = config.commands;
          const defaults = new Map<string, string | number | boolean>();
          config.parameters.forEach((param) => {
            const p = defaults.get(param.name);
            if (!p && param.default !== undefined) {
              // do not overwrite existing defaults
              defaults.set(param.name, param.default);
            }
          });
          // 3. Start ProxmoxExecution
          const exec = new ProxmoxExecution(commands, params, defaults);
          exec.on("message", (msg: IProxmoxExecuteMessage) => {
            this.messages.push(msg);
          });
          this.messages = [];
          exec.run();

          res.json({ success: true });
        } catch (err: any) {
          res
            .status(500)
            .json({ success: false, error: err.message || "Unknown error" });
        }
      },
    );
    // SSH config API
    this.app.get("/api/sshconfig", (req, res) => {
      try {
        const ssh: ISsh | null = ProxmoxExecution.getSshParameters();
        if (ssh) {
          res.json(ssh);
        } else {
          res.status(404).json({ error: "SSH config not set" });
        }
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    // GET /api/ProxmoxExecuteMessages: dequeues all messages in the queue and returns them
    this.app.get("/api/ProxmoxExecuteMessages", (req, res) => {
      res.json(this.messages);
    });

    this.app.post("/api/sshconfig", express.json(), (req, res) => {
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
        ProxmoxExecution.setSshParameters(ssh);
        res.json({ success: true });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get(
      "/api/getUnresolvedParameters/:application/:task",
      (req, res) => {
        const { application, task } = req.params;
        try {
          const config = new ProxmoxConfiguration(
            schemaPath,
            jsonPath,
            localJsonPath,
          );
          config.loadApplication(application, task as TaskType);
          res.json({ unresolvedParameters: config.getUnresolvedParameters() });
        } catch (err: any) {
          res
            .status(400)
            .json({ error: err.message, errors: err.errors || [] });
        }
      },
    );

    this.app.get("/api/applications", (req, res) => {
      try {
        const config = new ProxmoxConfiguration(
          schemaPath,
          jsonPath,
          localJsonPath,
        );
        const applications = config.listApplications();
        const testApplications =
          localJsonPath &&
          localJsonPath !== jsonPath &&
          existsSync(localJsonPath)
            ? config.listApplications()
            : [];

        res.json(applications.concat(testApplications));
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
  const schemaPath = path.join(dirname, "../schemas");
  const jsonPath = path.join(dirname, "../json");
  const configPath = path.join(dirname, "../config");
  const jsonTestPath = path.join(dirname, "../jsonTest");
  const webApp = new ProxmoxWebApp(schemaPath, jsonPath, jsonTestPath);
  const port = process.env.PORT || 3000;
  webApp.httpServer.listen(port, () => {
    console.log(`ProxmoxWebApp listening on port ${port}`);
  });
}
