import os from "os";
import { TaskType, IPostVeConfigurationBody, IVeExecuteMessagesResponse, IJsonError } from "@src/types.mjs";
import { WebAppVeMessageManager } from "./webapp-ve-message-manager.mjs";
import { WebAppVeRestartManager } from "./webapp-ve-restart-manager.mjs";
import { WebAppVeParameterProcessor } from "./webapp-ve-parameter-processor.mjs";
import { WebAppVeExecutionSetup } from "./webapp-ve-execution-setup.mjs";
import { VEConfigurationError, IVEContext, IVMInstallContext } from "@src/backend-types.mjs";
import { JsonError } from "@src/jsonvalidator.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { VMInstallContext } from "@src/context-manager.mjs";
import { determineExecutionMode, ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";

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
      const storageContext = PersistenceManager.getInstance().getContextManager();
      const ctx: IVEContext | null = storageContext.getVEContextByKey(veContextKey);
      if (!ctx) {
        return { success: false, error: "VE context not found", statusCode: 404 };
      }
      const veCtxToUse: IVEContext = ctx as IVEContext;
      const templateProcessor = veCtxToUse.getStorageContext().getTemplateProcessor();

      // Determine execution mode: TEST executes locally, PRODUCTION executes via SSH to VE host.
      const executionMode = determineExecutionMode();
      const sshCommand = executionMode === ExecutionMode.TEST ? "sh" : "ssh";
      
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
        executionMode,
        initialInputs, // Pass initialInputs so skip_if_all_missing can check user inputs
      );
      const commands = loaded.commands;
      if (!commands || commands.length === 0) {
        return {
          success: false,
          error: "No commands to execute for this task",
          statusCode: 422,
        };
      }
      const defaults = this.parameterProcessor.buildDefaults(loaded.parameters);

      // Built-in context variables (available to scripts as {{ application_id }}, etc.)
      // Do not require any template parameters.
      defaults.set("application", application);
      defaults.set("application_id", application);
      defaults.set(
        "application_name",
        (loaded.application && typeof (loaded.application as any).name === "string")
          ? String((loaded.application as any).name)
          : application,
      );
      defaults.set("task", task);
      defaults.set("task_type", task);

      // Log viewer URL parameters for Notes links
      // Priority: OCI_LXC_DEPLOYER_URL env var > auto-generated from hostname + port
      const deployerPort = process.env.PORT || "3000";
      const deployerUrl = process.env.OCI_LXC_DEPLOYER_URL
        || `http://${os.hostname()}:${deployerPort}`;
      defaults.set("deployer_base_url", deployerUrl);
      defaults.set("ve_context_key", veContextKey);

      const contextManager = PersistenceManager.getInstance().getContextManager();
      // Process parameters: for upload parameters with "local:" prefix, read file and base64 encode
      const processedParams = await this.parameterProcessor.processParameters(
        paramsToUse,
        loaded.parameters,
        contextManager,
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
  handleGetMessages(veContext: IVEContext): IVeExecuteMessagesResponse {
    // Add vmInstallKey to each message group if it exists
    const messages = this.messageManager.messages.map((group) => {
      // If vmInstallKey is already set, keep it
      if (group.vmInstallKey) {
        return group;
      }
      // Try to find vmInstallContext by looking up VE contexts
      const contextManager = PersistenceManager.getInstance().getContextManager();
      
          const vmInstallContext = contextManager.getVMInstallContextByHostnameAndApplication(
            veContext.host,
            group.application,
          );
          if (vmInstallContext) {
            const vmInstallKey = `vminstall_${veContext.host}_${group.application}`;
            // Update the group with vmInstallKey
            group.vmInstallKey = vmInstallKey;
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

    const contextManager = PersistenceManager.getInstance().getContextManager();
    const ctx = contextManager.getVEContextByKey(veContextKey);
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

    const executionMode = determineExecutionMode();
    const sshCommand = executionMode === ExecutionMode.TEST ? "sh" : "ssh";
    
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
        executionMode,
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
      PersistenceManager.getInstance().getContextManager(),
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
    const vmInstallContext = contextManager.getVMInstallContextByHostnameAndApplication(
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
    const contextManager = PersistenceManager.getInstance().getContextManager();
    const ctx = contextManager.getVEContextByKey(veContextKey);
    if (!ctx) {
      return { success: false, error: "VE context not found", statusCode: 404 };
    }

    // Get vmInstallContext
    const vmInstallContextValue = contextManager.getVMInstallContextByVmInstallKey(vmInstallKey);
    if (!vmInstallContextValue || !(vmInstallContextValue instanceof VMInstallContext)) {
      return { success: false, error: "VM install context not found", statusCode: 404 };
    }

    const installCtx = vmInstallContextValue as IVMInstallContext;
    const veCtxToUse = ctx as IVEContext;
    const templateProcessor = veCtxToUse.getStorageContext().getTemplateProcessor();

    const executionMode = determineExecutionMode();
    const sshCommand = executionMode === ExecutionMode.TEST ? "sh" : "ssh";
    
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
        executionMode,
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
      PersistenceManager.getInstance().getContextManager(),
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

