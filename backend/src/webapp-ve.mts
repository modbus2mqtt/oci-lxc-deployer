import { IVEContext, IVMContext } from "./backend-types.mjs";
import { StorageContext } from "./storagecontext.mjs";

import express, { RequestHandler } from "express";
import fs from "fs";
import path from "path";
import {
  ApiUri,
  IVeExecuteMessage,
  TaskType,
  IVeConfigurationResponse,
  IVeExecuteMessagesResponse,
  IPostVeConfigurationBody,
} from "./types.mjs";
import { IRestartInfo, VeExecution } from "./ve-execution.mjs";

const MESSAGE_RETENTION_MS = 30 * 60 * 1000; // 30 minutes

export class WebAppVE {
  messages: IVeExecuteMessagesResponse = [];
  private restartInfos: Map<string, IRestartInfo> = new Map();
  private messageTimestamps: Map<string, number> = new Map(); // key: "app/task"
  
  private cleanupOldMessages() {
    const now = Date.now();
    const keysToRemove: string[] = [];
    this.messageTimestamps.forEach((timestamp, key) => {
      if (now - timestamp > MESSAGE_RETENTION_MS) {
        keysToRemove.push(key);
      }
    });
    for (const key of keysToRemove) {
      const [app, task] = key.split('/');
      this.messages = this.messages.filter(
        g => !(g.application === app && g.task === task)
      );
      this.messageTimestamps.delete(key);
    }
  }
  
  returnResponse<T>(
    res: express.Response,
    payload: T,
    statusCode: number = 200,
  ) {
    res.status(statusCode).json(payload);
  }

  private post<
    TParams extends Record<string, string>,
    TBody,
    TQuery extends Record<string, string | undefined> = Record<string, string | undefined>
  >(
    path: string,
    handler: (
      req: express.Request<TParams, unknown, TBody, TQuery>,
      res: express.Response
    ) => void | Promise<unknown>
  ): void {
    this.app.post(path, express.json(), handler as unknown as RequestHandler);
  }

  constructor(private app: express.Application) {}
  init() {
    // Initialize VE specific web app features here
    // POST /api/proxmox-configuration/:application/:task
    this.post<
      { application: string; task: string; veContext: string },
      IPostVeConfigurationBody
    >(ApiUri.VeConfiguration, async (req, res) => {
      const { application, task, veContext: veContextKey } = req.params;
      const { params } = req.body;
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
        fs.writeFileSync(configPath, JSON.stringify(params, null, 2), "utf-8");

        // 2. Load application (provides commands)
        const storageContext = StorageContext.getInstance();
        const ctx: IVEContext | null =
          storageContext.getVEContextByKey(veContextKey);
        if (!ctx) {
          return res
            .status(404)
            .json({ success: false, error: "VE context not found" });
        }
        const veCtxToUse: IVEContext = ctx as IVEContext;
        const templateProcessor = veCtxToUse
          .getStorageContext()
          .getTemplateProcessor();
        const loaded = await templateProcessor.loadApplication(
          application,
          task as TaskType,
          veCtxToUse,
        );
        const commands = loaded.commands;
        const defaults = new Map<string, string | number | boolean>();
        loaded.parameters.forEach((param) => {
          const p = defaults.get(param.name);
          if (!p && param.default !== undefined) {
            // do not overwrite existing defaults
            defaults.set(param.id, param.default);
          }
        });
        // 3. Process parameters: for upload parameters with "local:" prefix, read file and base64 encode
        const processedParams = await Promise.all(params.map(async (p) => {
          const paramDef = loaded.parameters.find(param => param.id === p.name);
          if (paramDef?.upload && typeof p.value === 'string' && p.value.startsWith('local:')) {
            const filePath = p.value.substring(6); // Remove "local:" prefix
            const localPath = storageContext.getLocalPath();
            const fullPath = path.join(localPath, filePath);
            try {
              const fileContent = fs.readFileSync(fullPath);
              const base64Content = fileContent.toString('base64');
              return { id: p.name, value: base64Content };
            } catch (err: any) {
              throw new Error(`Failed to read file ${fullPath}: ${err.message}`);
            }
          }
          return { id: p.name, value: p.value };
        }));
        // 4. Start ProxmoxExecution
        const inputs = processedParams.map(p => ({ id: p.id, value: p.value }));
        const exec = new VeExecution(commands, inputs, veCtxToUse, defaults);
        // Generate restartKey upfront so we can return it immediately
        const newRestartKey = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        
        // Clear old messages for this application/task before starting
        this.messages = this.messages.filter(
          g => !(g.application === application && g.task === task)
        );
        const messageKey = `${application}/${task}`;
        this.messageTimestamps.set(messageKey, Date.now());
        
        // Cleanup old messages periodically
        this.cleanupOldMessages();
        
        exec.on("message", (msg: IVeExecuteMessage) => {
          const existing = this.messages.find(
            (g) => g.application === application && g.task === task,
          );
          if (existing) {
            existing.messages.push(msg);
          } else {
            this.messages.push({ application, task, messages: [msg], restartKey: newRestartKey });
          }
        });
        exec.on("finished", (msg: IVMContext) => {
          veCtxToUse.getStorageContext().setVMContext(msg);
        });
        
        // Respond immediately with restartKey, run execution in background
        this.returnResponse<IVeConfigurationResponse>(res, { success: true, restartKey: newRestartKey });
        
        // Run asynchronously - now non-blocking thanks to async spawn
        exec.run(null).then((result) => {
          // Always store result (even on error, result contains state for retry)
          if (result) {
            this.restartInfos.set(newRestartKey, result);
          } else {
            // Fallback if no result returned
            this.restartInfos.set(newRestartKey, {
              lastSuccessfull: -1,
              inputs: params.map(p => ({ name: p.name, value: p.value })),
              outputs: [],
              defaults: [],
            });
          }
        }).catch((err: Error) => {
          console.error("Execution error:", err.message);
          // Store minimal restartInfo so user can retry from beginning
          this.restartInfos.set(newRestartKey, {
            lastSuccessfull: -1,
            inputs: params.map(p => ({ name: p.name, value: p.value })),
            outputs: [],
            defaults: [],
          });
        });
      } catch (err: any) {
        res
          .status(500)
          .json({ success: false, error: err.message || "Unknown error" });
      }
    });
    // GET /api/ProxmoxExecuteMessages: dequeues all messages in the queue and returns them
    this.app.get(ApiUri.VeExecute, (req, res) => {
      this.returnResponse<IVeExecuteMessagesResponse>(res, this.messages);
    });
    
    // POST /api/ve/restart/:restartKey/:veContext - Restart execution with stored restartInfo
    this.app.post(ApiUri.VeRestart, express.json(), async (req, res) => {
      const { restartKey, veContext: veContextKey } = req.params;
      
      const restartInfo = this.restartInfos.get(restartKey);
      if (!restartInfo) {
        return res.status(404).json({ success: false, error: "Restart info not found" });
      }
      
      const storageContext = StorageContext.getInstance();
      const ctx = storageContext.getVEContextByKey(veContextKey);
      if (!ctx) {
        return res.status(404).json({ success: false, error: "VE context not found" });
      }
      
      // Get application/task from the message group that has this restartKey
      const messageGroup = this.messages.find(g => g.restartKey === restartKey);
      if (!messageGroup) {
        return res.status(404).json({ success: false, error: "No message group found for this restart key" });
      }
      
      const { application, task } = messageGroup;
      const veCtxToUse = ctx as IVEContext;
      
      // Reload application to get commands
      const templateProcessor = veCtxToUse.getStorageContext().getTemplateProcessor();
      const loaded = await templateProcessor.loadApplication(
        application,
        task as TaskType,
        veCtxToUse,
      );
      const commands = loaded.commands;
      const defaults = new Map<string, string | number | boolean>();
      loaded.parameters.forEach((param) => {
        if (param.default !== undefined && !defaults.has(param.id)) {
          defaults.set(param.id, param.default);
        }
      });
      
      // Create execution with reloaded commands but use restartInfo for state
      const exec = new VeExecution(commands, [], veCtxToUse, defaults);
      
      // Generate new restartKey
      const newRestartKey = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      
      // Clear old messages for this application/task
      this.messages = this.messages.filter(g => !(g.application === application && g.task === task));
      const messageKey = `${application}/${task}`;
      this.messageTimestamps.set(messageKey, Date.now());
      
      exec.on("message", (msg: IVeExecuteMessage) => {
        const existing = this.messages.find(g => g.application === application && g.task === task);
        if (existing) {
          existing.messages.push(msg);
        } else {
          this.messages.push({ application, task, messages: [msg], restartKey: newRestartKey });
        }
      });
      exec.on("finished", (msg: IVMContext) => {
        veCtxToUse.getStorageContext().setVMContext(msg);
      });
      
      this.returnResponse<IVeConfigurationResponse>(res, { success: true, restartKey: newRestartKey });
      
      exec.run(restartInfo).then((result) => {
        // Always store result (even on error, result contains state for retry)
        this.restartInfos.set(newRestartKey, result || restartInfo);
      }).catch((err: Error) => {
        console.error("Restart execution error:", err.message);
        // Even on error, store restartInfo so user can retry
        this.restartInfos.set(newRestartKey, restartInfo);
      });
    });
  }
}
