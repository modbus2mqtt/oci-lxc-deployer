import express, { RequestHandler } from "express";
import {
  ApiUri,
  IVeConfigurationResponse,
  IVeExecuteMessagesResponse,
  IPostVeConfigurationBody,
  TaskType,
} from "./types.mjs";
import { WebAppVeMessageManager } from "./webapp-ve-message-manager.mjs";
import { WebAppVeRestartManager } from "./webapp-ve-restart-manager.mjs";
import { WebAppVeParameterProcessor } from "./webapp-ve-parameter-processor.mjs";
import { WebAppVeExecutionSetup } from "./webapp-ve-execution-setup.mjs";
import { WebAppVeRouteHandlers } from "./webapp-ve-route-handlers.mjs";
import { StorageContext } from "./storagecontext.mjs";

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
      
      // Set vmInstallContext in StorageContext if changedParams are provided
      let vmInstallKey: string | undefined;
      if (req.body.changedParams && req.body.changedParams.length > 0) {
        const storageContext = StorageContext.getInstance();
        const veContext = storageContext.getVEContextByKey(veContextKey);
        if (veContext) {
          const hostname = typeof veContext.host === "string" 
            ? veContext.host 
            : (veContext.host as any)?.host || "unknown";
          vmInstallKey = storageContext.setVMInstallContext({
            hostname,
            application,
            task: task as TaskType,
            changedParams: req.body.changedParams.map(p => ({ name: p.name, value: p.value })),
          });
        }
      }
      
      const result = await this.routeHandlers.handleVeConfiguration(
        application,
        task,
        veContextKey,
        req.body,
      );
      if (result.success && result.restartKey) {
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
    this.app.get(ApiUri.VeExecute, (req, res) => {
      const messages = this.routeHandlers.handleGetMessages();
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
  }
}
