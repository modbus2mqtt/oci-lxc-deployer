import express, { RequestHandler } from "express";
import {
  ApiUri,
  IVeConfigurationResponse,
  IVeExecuteMessagesResponse,
  IPostVeConfigurationBody,
  IPostVeCopyUpgradeBody,
  TaskType,
} from "./types.mjs";
import { WebAppVeMessageManager } from "./webapp-ve-message-manager.mjs";
import { WebAppVeRestartManager } from "./webapp-ve-restart-manager.mjs";
import { WebAppVeParameterProcessor } from "./webapp-ve-parameter-processor.mjs";
import { WebAppVeExecutionSetup } from "./webapp-ve-execution-setup.mjs";
import { WebAppVeRouteHandlers } from "./webapp-ve-route-handlers.mjs";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";
import { VMInstallContext } from "./context-manager.mjs";

export class WebAppVE {
  private messageManager: WebAppVeMessageManager;
  private restartManager: WebAppVeRestartManager;
  private parameterProcessor: WebAppVeParameterProcessor;
  private executionSetup: WebAppVeExecutionSetup;
  private routeHandlers: WebAppVeRouteHandlers;

  constructor(private app: express.Application) {
    this.messageManager = new WebAppVeMessageManager();
    this.restartManager = new WebAppVeRestartManager();
    this.parameterProcessor = new WebAppVeParameterProcessor();
    this.executionSetup = new WebAppVeExecutionSetup();
    this.routeHandlers = new WebAppVeRouteHandlers(
      this.messageManager,
      this.restartManager,
      this.parameterProcessor,
      this.executionSetup,
    );
  }

  /**
   * Exposes messages for GET endpoint (backward compatibility).
   */
  get messages(): IVeExecuteMessagesResponse {
    return this.messageManager.messages;
  }

  private returnResponse<T>(
    res: express.Response,
    payload: T,
    statusCode: number = 200,
  ): void {
    res.status(statusCode).json(payload);
  }

  private post<
    TParams extends Record<string, string>,
    TBody,
    TQuery extends Record<string, string | undefined> = Record<
      string,
      string | undefined
    >,
  >(
    path: string,
    handler: (
      req: express.Request<TParams, unknown, TBody, TQuery>,
      res: express.Response,
    ) => void | Promise<unknown>,
  ): void {
    this.app.post(path, express.json(), handler as unknown as RequestHandler);
  }

  init(): void {
    // POST /api/ve-configuration/:application/:task/:veContext
    this.post<
      { application: string; task: string; veContext: string },
      IPostVeConfigurationBody
    >(ApiUri.VeConfiguration, async (req, res) => {
      const { application, task, veContext: veContextKey } = req.params;
      
      // Set vmInstallContext in ContextManager if changedParams are provided
      // Update existing context with new changedParams if context exists
      let vmInstallKey: string | undefined;
      // Access changedParams from body (may be undefined if not provided)
      const changedParams = req.body?.changedParams;
      if (changedParams && Array.isArray(changedParams) && changedParams.length > 0) {
        const storageContext = PersistenceManager.getInstance().getContextManager();
        const veContext = storageContext.getVEContextByKey(veContextKey);
        if (veContext) {
          const hostname = typeof veContext.host === "string" 
            ? veContext.host 
            : (veContext.host as any)?.host || "unknown";
          // Check if context already exists
          const tempContext = new VMInstallContext({
            hostname,
            application,
            task: task as TaskType,
            changedParams: [],
          });
          const existingKey = tempContext.getKey();
          const existingContext = storageContext.get(existingKey);
          
          // Map changedParams from request
          const mappedChangedParams = changedParams.map((p: any) => ({ name: p.name, value: p.value }));
          
          if (existingContext instanceof VMInstallContext) {
            // Context exists - update it with new changedParams
            vmInstallKey = storageContext.setVMInstallContext({
              hostname,
              application,
              task: task as TaskType,
              changedParams: mappedChangedParams,
            });
          } else {
            // Context doesn't exist - create new one
            vmInstallKey = storageContext.setVMInstallContext({
              hostname,
              application,
              task: task as TaskType,
              changedParams: mappedChangedParams,
            });
          }
        }
      }
      
      const result = await this.routeHandlers.handleVeConfiguration(
        application,
        task,
        veContextKey,
        req.body,
      );
      if (result.success && result.restartKey) {
        // Set vmInstallKey in message group if it exists
        if (vmInstallKey) {
          this.messageManager.setVmInstallKeyForGroup(application, task, vmInstallKey);
        }
        const response: IVeConfigurationResponse = { 
          success: true, 
          restartKey: result.restartKey,
          ...(vmInstallKey && { vmInstallKey }),
        };
        this.returnResponse<IVeConfigurationResponse>(res, response, 200);
      } else {
        const errorResponse: any = {
          success: false,
          error: result.error || "Unknown error",
        };
        if (result.errorDetails) {
          errorResponse.errorDetails = result.errorDetails;
        }
        res.status(result.statusCode || 500).json(errorResponse);
      }
    });

    // POST /api/ve/restart-installation/:vmInstallKey/:veContext
    this.post<
      { vmInstallKey: string; veContext: string },
      IPostVeConfigurationBody
    >(ApiUri.VeRestartInstallation, async (req, res) => {
      const { vmInstallKey, veContext: veContextKey } = req.params;
      const result = await this.routeHandlers.handleVeRestartInstallation(vmInstallKey, veContextKey);
      if (result.success && result.restartKey) {
        const response: IVeConfigurationResponse = { 
          success: true, 
          restartKey: result.restartKey,
          ...(result.vmInstallKey && { vmInstallKey: result.vmInstallKey }),
        };
        this.returnResponse<IVeConfigurationResponse>(res, response, 200);
      } else {
        const errorResponse: any = {
          success: false,
          error: result.error || "Unknown error",
        };
        if (result.errorDetails) {
          errorResponse.errorDetails = result.errorDetails;
        }
        res.status(result.statusCode || 500).json(errorResponse);
      }
    });

    // GET /api/ve/execute/:veContext
    this.app.get<{ veContext: string }>(ApiUri.VeExecute, (req, res) => {
      const storageContext = PersistenceManager.getInstance().getContextManager();
       const veContext = storageContext.getVEContextByKey(req.params.veContext);
       if (!veContext) {
        res.status(404).json({ error: "VE context not found" });
        return;
       }
       
      const messages = this.routeHandlers.handleGetMessages(veContext);
      this.returnResponse<IVeExecuteMessagesResponse>(res, messages);
    });

    // POST /api/ve/restart/:restartKey/:veContext
    this.app.post(ApiUri.VeRestart, express.json(), async (req, res) => {
      const { restartKey, veContext: veContextKey } = req.params;
      const result = await this.routeHandlers.handleVeRestart(restartKey, veContextKey);
      if (result.success && result.restartKey) {
        const response: IVeConfigurationResponse = { 
          success: true, 
          restartKey: result.restartKey,
          ...(result.vmInstallKey && { vmInstallKey: result.vmInstallKey }),
        };
        this.returnResponse<IVeConfigurationResponse>(res, response, 200);
      } else {
        const errorResponse: any = {
          success: false,
          error: result.error || "Unknown error",
        };
        if (result.errorDetails) {
          errorResponse.errorDetails = result.errorDetails;
        }
        res.status(result.statusCode || 500).json(errorResponse);
      }
    });

    // POST /api/ve/copy-upgrade/:application/:veContext
    // Starts the application "copy-upgrade" task (per application.schema.json) without persisting a VMInstallContext.
    this.post<
      { application: string; veContext: string },
      IPostVeCopyUpgradeBody
    >(ApiUri.VeCopyUpgrade, async (req, res) => {
      const { application, veContext: veContextKey } = req.params;
      const body = req.body;

      // Minimal validation for required copy-upgrade fields
      if (!body || typeof body !== "object") {
        res.status(400).json({ success: false, error: "Invalid body" });
        return;
      }
      if (!body.oci_image || typeof body.oci_image !== "string") {
        res.status(400).json({ success: false, error: "Missing oci_image" });
        return;
      }
      if (body.source_vm_id === undefined || body.source_vm_id === null || typeof body.source_vm_id !== "number") {
        res.status(400).json({ success: false, error: "Missing source_vm_id" });
        return;
      }

      const params: { name: string; value: any }[] = [];
      const add = (name: string, value: any) => {
        if (value === undefined || value === null) return;
        if (typeof value === "string" && value.trim() === "") return;
        params.push({ name, value });
      };

      add("oci_image", body.oci_image);
      add("source_vm_id", body.source_vm_id);
      add("vm_id", body.vm_id);
      add("disk_size", body.disk_size);
      add("bridge", body.bridge);
      add("memory", body.memory);
      add("storage", body.storage);
      add("registry_username", body.registry_username);
      add("registry_password", body.registry_password);
      add("registry_token", body.registry_token);
      add("platform", body.platform);

      const result = await this.routeHandlers.handleVeConfiguration(
        application,
        "copy-upgrade",
        veContextKey,
        { params } as unknown as IPostVeConfigurationBody,
      );

      if (result.success && result.restartKey) {
        const response: IVeConfigurationResponse = {
          success: true,
          restartKey: result.restartKey,
        };
        this.returnResponse<IVeConfigurationResponse>(res, response, 200);
      } else {
        const errorResponse: any = {
          success: false,
          error: result.error || "Unknown error",
        };
        if (result.errorDetails) {
          errorResponse.errorDetails = result.errorDetails;
        }
        res.status(result.statusCode || 500).json(errorResponse);
      }
    });
  }
}
