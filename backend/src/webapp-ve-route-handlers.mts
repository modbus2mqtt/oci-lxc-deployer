import { IVEContext, IVMInstallContext, VEConfigurationError } from "./backend-types.mjs";
import { StorageContext, VMInstallContext } from "./storagecontext.mjs";
import { TaskType, IPostVeConfigurationBody, IVeExecuteMessagesResponse, IJsonError } from "./types.mjs";
import { WebAppVeMessageManager } from "./webapp-ve-message-manager.mjs";
import { WebAppVeRestartManager } from "./webapp-ve-restart-manager.mjs";
import { WebAppVeParameterProcessor } from "./webapp-ve-parameter-processor.mjs";
import { WebAppVeExecutionSetup } from "./webapp-ve-execution-setup.mjs";
import { JsonError } from "./jsonvalidator.mjs";

/**
 * Route handler logic for VE configuration endpoints.
 * Separated from Express binding for better testability.
 */
export class WebAppVeRouteHandlers {
  constructor(
    private messageManager: WebAppVeMessageManager,
    private restartManager: WebAppVeRestartManager,
    private parameterProcessor: WebAppVeParameterProcessor,
    private executionSetup: WebAppVeExecutionSetup,
  ) {}

  /**
   * Determines the appropriate HTTP status code for an error.
   * Returns 422 (Unprocessable Entity) for validation/configuration errors,
   * 500 (Internal Server Error) for unexpected server errors.
   */
  private getErrorStatusCode(err: unknown): number {
    // Check if error is a validation/configuration error
    if (err instanceof JsonError || err instanceof VEConfigurationError) {
      return 422; // Unprocessable Entity - validation/configuration error
    }
    // Check if error has a name property indicating it's a validation error
    if (err && typeof err === 'object' && 'name' in err) {
      const errorName = (err as { name?: string }).name;
      if (errorName === 'JsonError' || errorName === 'VEConfigurationError' || errorName === 'ValidateJsonError') {
        return 422;
      }
    }
    // Default to 500 for unexpected errors
    return 500;
  }

  /**
   * Serializes an error to a JSON-serializable object.
   * Uses toJSON() if available, otherwise extracts error properties.
   */
  private serializeError(err: unknown): IJsonError | string {
    if (!err) {
      return "Unknown error";
    }

    // If error has a toJSON method, use it
    if (err && typeof err === 'object' && 'toJSON' in err && typeof (err as any).toJSON === 'function') {
      return (err as any).toJSON();
    }

    // If it's an Error instance, extract properties
    if (err instanceof Error) {
      const errorObj: any = {
        name: err.name,
        message: err.message,
      };
      
      // If it's a JsonError or VEConfigurationError, try to get details
      if (err instanceof JsonError || err instanceof VEConfigurationError) {
        if ((err as any).details) {
          errorObj.details = (err as any).details;
        }
        if ((err as any).filename) {
          errorObj.filename = (err as any).filename;
        }
      }

      return errorObj;
    }

    // For other types, try to convert to string or return as-is
    if (typeof err === 'string') {
      return err;
    }

    // Last resort: try to serialize the object
    try {
      return JSON.parse(JSON.stringify(err)) as IJsonError;
    } catch {
      return String(err);
    }
  }

  /**
   * Validates request body for VeConfiguration endpoint.
   */
  validateVeConfigurationBody(body: IPostVeConfigurationBody): { valid: boolean; error?: string } {
    if (!Array.isArray(body.params)) {
      return { valid: false, error: "Invalid parameters" };
    }
    if (body.outputs !== undefined && !Array.isArray(body.outputs)) {
      return { valid: false, error: "Invalid outputs" };
    }
    if (body.changedParams !== undefined && !Array.isArray(body.changedParams)) {
      return { valid: false, error: "Invalid changedParams" };
    }
    return { valid: true };
  }

  /**
   * Handles POST /api/ve-configuration/:application/:task/:veContext
   */
  async handleVeConfiguration(
    application: string,
    task: string,
    veContextKey: string,
    body: IPostVeConfigurationBody,
  ): Promise<{ success: boolean; restartKey?: string; vmInstallKey?: string; error?: string; errorDetails?: IJsonError; statusCode?: number }> {
    // Validate request body
    const validation = this.validateVeConfigurationBody(body);
    if (!validation.valid) {
      return { 
        success: false, 
        ...(validation.error && { error: validation.error }), 
        statusCode: 400 
      };
    }

    try {
      // Load application (provides commands)
      const storageContext = StorageContext.getInstance();
      const ctx: IVEContext | null = storageContext.getVEContextByKey(veContextKey);
      if (!ctx) {
        return { success: false, error: "VE context not found", statusCode: 404 };
      }
      const veCtxToUse: IVEContext = ctx as IVEContext;
      const templateProcessor = veCtxToUse.getStorageContext().getTemplateProcessor();

      // Determine sshCommand: use "sh" in test environments (when NODE_ENV is test or when explicitly set)
      // Otherwise use "ssh" for real connections
      const sshCommand = process.env.NODE_ENV === "test" || process.env.LXC_MANAGER_TEST_MODE === "true" 
        ? "sh" 
        : "ssh";
      
      const loaded = await templateProcessor.loadApplication(
        application,
        task as TaskType,
        veCtxToUse,
        sshCommand,
      );
      const commands = loaded.commands;
      const defaults = this.parameterProcessor.buildDefaults(loaded.parameters);

      // Use changedParams if provided (even if empty), otherwise fall back to params
      // This allows restarting installation with only changed parameters
      // For normal installation, changedParams should contain all changed parameters
      const paramsToUse = body.changedParams !== undefined
        ? body.changedParams
        : body.params;

      // Process parameters: for upload parameters with "local:" prefix, read file and base64 encode
      const processedParams = await this.parameterProcessor.processParameters(
        paramsToUse,
        loaded.parameters,
        storageContext,
      );

      // Start ProxmoxExecution
      const inputs = processedParams.map((p) => ({
        id: p.id,
        value: p.value,
      }));

      const { exec, restartKey } = this.executionSetup.setupExecution(
        commands,
        inputs,
        defaults,
        veCtxToUse,
        this.messageManager,
        this.restartManager,
        application,
        task,
        sshCommand,
      );

      // Respond immediately with restartKey, run execution in background
      const fallbackRestartInfo = this.restartManager.createFallbackRestartInfo(body.params);
      this.executionSetup.setupExecutionResultHandlers(
        exec,
        restartKey,
        this.restartManager,
        fallbackRestartInfo,
      );

      return { 
        success: true, 
        restartKey,
      };
    } catch (err: any) {
      const serializedError = this.serializeError(err);
      const statusCode = this.getErrorStatusCode(err);
      const result: { success: false; error: string; errorDetails?: IJsonError; statusCode: number } = { 
        success: false, 
        error: typeof serializedError === 'string' ? serializedError : serializedError.message || "Unknown error",
        statusCode,
      };
      if (typeof serializedError === 'object') {
        result.errorDetails = serializedError;
      }
      return result;
    }
  }

  /**
   * Handles GET /api/ve/execute/:veContext
   */
  handleGetMessages(): IVeExecuteMessagesResponse {
    return this.messageManager.messages;
  }

  /**
   * Handles POST /api/ve/restart/:restartKey/:veContext
   */
  async handleVeRestart(
    restartKey: string,
    veContextKey: string,
  ): Promise<{ success: boolean; restartKey?: string; vmInstallKey?: string; error?: string; errorDetails?: IJsonError; statusCode?: number }> {
    const restartInfo = this.restartManager.getRestartInfo(restartKey);
    if (!restartInfo) {
      return { success: false, error: "Restart info not found", statusCode: 404 };
    }

    const storageContext = StorageContext.getInstance();
    const ctx = storageContext.getVEContextByKey(veContextKey);
    if (!ctx) {
      return { success: false, error: "VE context not found", statusCode: 404 };
    }

    // Get application/task from the message group that has this restartKey
    const messageGroup = this.messageManager.findMessageGroupByRestartKey(restartKey);
    if (!messageGroup) {
      return { success: false, error: "No message group found for this restart key", statusCode: 404 };
    }

    const { application, task } = messageGroup;
    const veCtxToUse = ctx as IVEContext;

    // Determine sshCommand: use "sh" in test environments
    const sshCommand = process.env.NODE_ENV === "test" || process.env.LXC_MANAGER_TEST_MODE === "true" 
      ? "sh" 
      : "ssh";
    
    // Reload application to get commands
    const templateProcessor = veCtxToUse.getStorageContext().getTemplateProcessor();
    let loaded;
    try {
      loaded = await templateProcessor.loadApplication(
        application,
        task as TaskType,
        veCtxToUse,
        sshCommand,
      );
    } catch (err: any) {
      const serializedError = this.serializeError(err);
      const statusCode = this.getErrorStatusCode(err);
      const result: { success: false; error: string; errorDetails?: IJsonError; statusCode: number } = { 
        success: false, 
        error: typeof serializedError === 'string' ? serializedError : serializedError.message || "Unknown error",
        statusCode,
      };
      if (typeof serializedError === 'object') {
        result.errorDetails = serializedError;
      }
      return result;
    }
    const commands = loaded.commands;
    const defaults = this.parameterProcessor.buildDefaults(loaded.parameters);

    // Create execution with reloaded commands but use restartInfo for state
    const { exec, restartKey: newRestartKey } = this.executionSetup.setupExecution(
      commands,
      [],
      defaults,
      veCtxToUse,
      this.messageManager,
      this.restartManager,
      application,
      task,
      sshCommand,
    );

    this.executionSetup.setupRestartExecutionResultHandlers(
      exec,
      newRestartKey,
      restartInfo,
      this.restartManager,
    );

    // Try to find vmInstallContext for this installation to return vmInstallKey
    const hostname = typeof veCtxToUse.host === "string" 
      ? veCtxToUse.host 
      : (veCtxToUse.host as any)?.host || "unknown";
    const vmInstallContext = storageContext.getVMInstallContextByHostnameAndApplication(
      hostname,
      application,
    );
    const vmInstallKey = vmInstallContext ? `vminstall_${hostname}_${application}` : undefined;

    return { 
      success: true, 
      restartKey: newRestartKey,
      ...(vmInstallKey && { vmInstallKey }),
    };
  }

  /**
   * Handles POST /api/ve/restart-installation/:vmInstallKey/:veContext
   * Restarts an installation from scratch using the vmInstallContext.
   */
  async handleVeRestartInstallation(
    vmInstallKey: string,
    veContextKey: string,
  ): Promise<{ success: boolean; restartKey?: string; vmInstallKey?: string; error?: string; errorDetails?: IJsonError; statusCode?: number }> {
    const storageContext = StorageContext.getInstance();
    const ctx = storageContext.getVEContextByKey(veContextKey);
    if (!ctx) {
      return { success: false, error: "VE context not found", statusCode: 404 };
    }

    // Get vmInstallContext
    const vmInstallContextValue = storageContext.get(vmInstallKey);
    if (!vmInstallContextValue || !(vmInstallContextValue instanceof VMInstallContext)) {
      return { success: false, error: "VM install context not found", statusCode: 404 };
    }

    const installCtx = vmInstallContextValue as IVMInstallContext;
    const veCtxToUse = ctx as IVEContext;
    const templateProcessor = veCtxToUse.getStorageContext().getTemplateProcessor();

    // Determine sshCommand: use "sh" in test environments
    const sshCommand = process.env.NODE_ENV === "test" || process.env.LXC_MANAGER_TEST_MODE === "true" 
      ? "sh" 
      : "ssh";
    
    // Load application to get commands
    let loaded;
    try {
      loaded = await templateProcessor.loadApplication(
        installCtx.application,
        installCtx.task,
        veCtxToUse,
        sshCommand,
      );
    } catch (err: any) {
      const serializedError = this.serializeError(err);
      const statusCode = this.getErrorStatusCode(err);
      const result: { success: false; error: string; errorDetails?: IJsonError; statusCode: number } = { 
        success: false, 
        error: typeof serializedError === 'string' ? serializedError : serializedError.message || "Unknown error",
        statusCode,
      };
      if (typeof serializedError === 'object') {
        result.errorDetails = serializedError;
      }
      return result;
    }
    const commands = loaded.commands;
    const defaults = this.parameterProcessor.buildDefaults(loaded.parameters);

    // Use changedParams from vmInstallContext as inputs
    const processedParams = await this.parameterProcessor.processParameters(
      installCtx.changedParams,
      loaded.parameters,
      storageContext,
    );

    const inputs = processedParams.map((p) => ({
      id: p.id,
      value: p.value,
    }));

    const { exec, restartKey } = this.executionSetup.setupExecution(
      commands,
      inputs,
      defaults,
      veCtxToUse,
      this.messageManager,
      this.restartManager,
      installCtx.application,
      installCtx.task,
      sshCommand,
    );

    // Respond immediately with restartKey, run execution in background
    const fallbackRestartInfo = this.restartManager.createFallbackRestartInfo(installCtx.changedParams);
    this.executionSetup.setupExecutionResultHandlers(
      exec,
      restartKey,
      this.restartManager,
      fallbackRestartInfo,
    );

    return { 
      success: true, 
      restartKey,
      ...(vmInstallKey && { vmInstallKey }),
    };
  }
}

