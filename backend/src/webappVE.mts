import { IVEContext } from "./backend-types.mjs";

import express from "express";
import fs from "fs";
import path from "path";
import { ApiUri, IProxmoxExecuteMessage, TaskType } from "./types.mjs";
import { VeExecution } from "./ve-execution.mjs";

export class WebAppVE {
  messages: IProxmoxExecuteMessage[] = [];

  constructor(
    private app: express.Application,
    private veContext: IVEContext,
  ) {}
  init() {
    // Initialize VE specific web app features here
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
          const templateProcessor = this.veContext
            .getStorageContext()
            .getTemplateProcessor();
          const loaded = templateProcessor.loadApplication(
            application,
            task as TaskType,
          );
          // const webuiTemplates = loaded.webuiTemplates;
          //templateProcessor.loadTemplatesForApplication(application, webuiTemplates);
          const commands = loaded.commands;
          const defaults = new Map<string, string | number | boolean>();
          loaded.parameters.forEach((param) => {
            const p = defaults.get(param.name);
            if (!p && param.default !== undefined) {
              // do not overwrite existing defaults
              defaults.set(param.name, param.default);
            }
          });
          // 3. Start ProxmoxExecution
          const exec = new VeExecution(
            commands,
            params,
            this.veContext,
            defaults,
          );
          exec.on("message", (msg: IProxmoxExecuteMessage) => {
            this.messages.push(msg);
          });
          this.messages = [];
          exec.run();

          res.json({ success: true });
          res.status(200);
        } catch (err: any) {
          res
            .status(500)
            .json({ success: false, error: err.message || "Unknown error" });
        }
      },
    );
    // GET /api/ProxmoxExecuteMessages: dequeues all messages in the queue and returns them
    this.app.get(ApiUri.ProxmoxExecute, (req, res) => {
      res.json(this.messages);
    });
  }
}
