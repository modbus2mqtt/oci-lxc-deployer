import { IVEContext, IVMContext } from "./backend-types.mjs";
import { StorageContext } from "./storagecontext.mjs";

import express from "express";
import fs from "fs";
import path from "path";
import { ApiUri, IProxmoxExecuteMessage, TaskType } from "./types.mjs";
import { IRestartInfo, VeExecution } from "./ve-execution.mjs";

export class WebAppVE {
  messages: IProxmoxExecuteMessage[] = [];
  private restartInfos: Map<string, IRestartInfo> = new Map();

  constructor(
    private app: express.Application,
  ) {}
  init() {
    // Initialize VE specific web app features here
    // POST /api/proxmox-configuration/:application/:task
    this.app.post(
      ApiUri.VeConfiguration,
      express.json(),
      async (req, res) => {
        const { application, task } = req.params;
        const restartKeyParam = (req.query.restartKey as string | undefined) || undefined;
        const veContextKey = (req.query.veContext as string | undefined) || undefined;
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
          const storageContext = StorageContext.getInstance();
          if (!veContextKey) {
            return res.status(400).json({ success: false, error: "Missing veContext" });
          }
          const ctx: IVEContext | null = storageContext.getVEContextByKey(veContextKey);
          if (!ctx) {
            return res.status(404).json({ success: false, error: "VE context not found" });
          }
          const veCtxToUse: IVEContext = ctx as IVEContext;
          const templateProcessor = veCtxToUse
            .getStorageContext()
            .getTemplateProcessor();
          const loaded = templateProcessor.loadApplication(
            application,
            task as TaskType,
            veCtxToUse
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
            veCtxToUse,
            defaults,
          );
          exec.on("message", (msg: IProxmoxExecuteMessage) => {
            this.messages.push(msg);
          });
          exec.on("finished", (msg: IVMContext) => {
            veCtxToUse.getStorageContext().setVMContext(msg);
          });
          this.messages = [];
          let restartInfoToUse: IRestartInfo | undefined = undefined;
          if (restartKeyParam) {
            const stored = this.restartInfos.get(restartKeyParam);
            if (stored) restartInfoToUse = stored;
          }
          const result = exec.run(restartInfoToUse);
          if (result) {
            const key = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
            this.restartInfos.set(key, result);
            res.status(200).json({ success: false, restartKey: key });
            return;
          }
          res.status(200).json({ success: true });
        } catch (err: any) {
          res
            .status(500)
            .json({ success: false, error: err.message || "Unknown error" });
        }
      },
    );
    // GET /api/ProxmoxExecuteMessages: dequeues all messages in the queue and returns them
    this.app.get(ApiUri.VeExecute, (req, res) => {
      res.json(this.messages);
    });
  }
}
