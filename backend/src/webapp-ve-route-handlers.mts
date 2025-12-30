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
   * Recursively serializes an array of details, handling both JsonError instances and plain objects.
   */
  private serializeDetailsArray(details: IJsonError[] | undefined): IJsonError[] | undefined {
    if (!details || !Array.isArray(details)) {
      return undefined;
    }
    
    return details.map((d) => {
      // If it's a JsonError instance with toJSON, use it
      if (d && typeof d === 'object' && typeof (d as any).toJSON === "function") {
        return (d as any).toJSON();
      }
      
      // If it's already a plain object with the expected structure, ensure details are serialized
      if (d && typeof d === 'object') {
        const result: any = {
          name: (d as any).name,
          message: (d as any).message,
          line: (d as any).line,
        };
        
        // Recursively serialize nested details if they exist
        if ((d as any).details && Array.isArray((d as any).details)) {
          result.details = this.serializeDetailsArray((d as any).details);
        }
        
        if ((d as any).filename !== undefined) result.filename = (d as any).filename;
        
        return result as IJsonError;
      }
      
      // Fallback: convert to string or return as-is
      return {
        name: 'Error',
        message: String(d),
        details: undefined
      } as IJsonError;
    });
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
        // Use toJSON() if available to ensure proper recursive serialization
        if (typeof (err as any).toJSON === 'function') {
          return (err as any).toJSON();
        }
        
        // Fallback: manually extract details and serialize them
        if ((err as any).details) {
          errorObj.details = this.serializeDetailsArray((err as any).details);
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
      
      // Use changedParams if provided (even if empty), otherwise fall back to params
      // This allows restarting installation with only changed parameters
      // For normal installation, changedParams should contain all changed parameters
      const paramsToUse = body.changedParams !== undefined
        ? body.changedParams
        : body.params;

      // Prepare initialInputs for loadApplication (for skip_if_all_missing checks)
      // Convert params to initialInputs format (only non-empty values)
      const initialInputs = paramsToUse
        .filter((p) => p.value !== null && p.value !== undefined && p.value !== '')
        .map((p) => ({
          id: p.name,
          value: p.value,
        }));

      const loaded = await templateProcessor.loadApplication(
        application,
        task as TaskType,
        veCtxToUse,
        sshCommand,
        initialInputs, // Pass initialInputs so skip_if_all_missing can check user inputs
      );
      const commands = loaded.commands;
      const defaults = this.parameterProcessor.buildDefaults(loaded.parameters);

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
    const storageContext = StorageContext.getInstance();
    // Add vmInstallKey to each message group if it exists
    const messages = this.messageManager.messages.map((group) => {
      // If vmInstallKey is already set, keep it
      if (group.vmInstallKey) {
        return group;
      }
      // Try to find vmInstallContext by looking up VE contexts
      // We need to find the hostname from any VE context
      for (const key of storageContext.keys().filter((k) => k.startsWith("ve_"))) {
        const veContext = storageContext.getVEContextByKey(key.replace("ve_", ""));
        if (veContext) {
          const hostname = typeof veContext.host === "string" 
            ? veContext.host 
            : (veContext.host as any)?.host || "unknown";
          const vmInstallContext = storageContext.getVMInstallContextByHostnameAndApplication(
            hostname,
            group.application,
          );
          if (vmInstallContext) {
            const vmInstallKey = `vminstall_${hostname}_${group.application}`;
            // Update the group with vmInstallKey
            group.vmInstallKey = vmInstallKey;
            break;
          }
        }
      }
      return group;
    });
    return messages;
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
      // Use parameters from restartInfo.inputs for skip_if_all_missing checks
      const initialInputs = restartInfo.inputs
        .filter((p) => p.value !== null && p.value !== undefined && p.value !== '')
        .map((p) => ({
          id: p.name,
          value: p.value,
        }));

      loaded = await templateProcessor.loadApplication(
        application,
        task as TaskType,
        veCtxToUse,
        sshCommand,
        initialInputs,
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

    // Process parameters from restartInfo.inputs
    const paramsFromRestartInfo = restartInfo.inputs.map((p) => ({
      name: p.name,
      value: p.value,
    }));
    
    const processedParams = await this.parameterProcessor.processParameters(
      paramsFromRestartInfo,
      loaded.parameters,
      storageContext,
    );

    const inputs = processedParams.map((p) => ({
      id: p.id,
      value: p.value,
    }));

    // Create execution with reloaded commands but use restartInfo for state
    const { exec, restartKey: newRestartKey } = this.executionSetup.setupExecution(
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
    
    // Prepare initialInputs for loadApplication (for skip_if_all_missing checks)
    const initialInputs = installCtx.changedParams
      .filter((p) => p.value !== null && p.value !== undefined && p.value !== '')
      .map((p) => ({
        id: p.name,
        value: p.value,
      }));

    // Load application to get commands (with initialInputs for skip_if_all_missing checks)
    let loaded;
    try {
      loaded = await templateProcessor.loadApplication(
        installCtx.application,
        installCtx.task,
        veCtxToUse,
        sshCommand,
        initialInputs, // Pass initialInputs so skip_if_all_missing can check user inputs
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

    // Set vmInstallKey in message group if it exists
    if (vmInstallKey) {
      this.messageManager.setVmInstallKeyForGroup(installCtx.application, installCtx.task, vmInstallKey);
    }

    return { 
      success: true, 
      restartKey,
      ...(vmInstallKey && { vmInstallKey }),
    };
  }
}

