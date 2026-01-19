import { EventEmitter } from "events";
import { JsonError } from "@src/jsonvalidator.mjs";
import {
  IConfiguredPathes,
  IReadApplicationOptions,
  IResolvedParam,
  VEConfigurationError,
  VELoadApplicationError,
  IApplication,
} from "@src/backend-types.mjs";
import {
  TaskType,
  ITemplate,
  ICommand,
  IParameter,
  IJsonError,
  IParameterValue,
} from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { ApplicationLoader } from "@src/apploader.mjs";
import { ScriptValidator } from "@src/scriptvalidator.mjs";
import { ContextManager } from "../context-manager.mjs";
import { ITemplatePersistence, IApplicationPersistence } from "../persistence/interfaces.mjs";
import { FileSystemRepositories, type TemplateRef, type ScriptRef, type MarkdownRef } from "../persistence/repositories.mjs";
import { VeExecution } from "../ve-execution/ve-execution.mjs";
import { ExecutionMode, determineExecutionMode } from "../ve-execution/ve-execution-constants.mjs";
// ITemplateReference moved to backend-types.mts
import { ITemplateReference } from "../backend-types.mjs";
interface IProcessTemplateOpts {
  application: string;
  template: ITemplateReference | string;
  templatename: string;
  resolvedParams: IResolvedParam[];
  parameters: IParameterWithTemplate[];
  commands: ICommand[];
  visitedTemplates?: Set<string>;
  errors?: IJsonError[];
  requestedIn?: string | undefined;
  parentTemplate?: string | undefined;
  webuiTemplates: string[];
  templateRef?: TemplateRef;
  veContext?: IVEContext;
  executionMode?: ExecutionMode;  // Execution mode for VeExecution
  enumValueInputs?: { id: string; value: IParameterValue }[];
  enumValuesRefresh?: boolean;
  processedTemplates?: Map<string, IProcessedTemplate>;  // NEW: Collects template information
  templateReferences?: Map<string, Set<string>>;  // NEW: Template references (template -> referenced templates)
  outputSources?: Map<string, { template: string; kind: "outputs" | "properties" }>; // NEW: Output provenance
}
export interface IParameterWithTemplate extends IParameter {
  template: string;
}
export interface IProcessedTemplate {
  name: string;              // Template name (without .json)
  path: string;              // Full path to the template file
  isShared: boolean;         // true = shared template, false = app-specific
  skipped: boolean;          // true = all commands skipped
  conditional: boolean;       // true = skip_if_all_missing or skip_if_property_set
  referencedBy?: string[];    // Templates that reference this template
  references?: string[];      // Templates referenced by this template
  templateData?: ITemplate;   // NEW: Full template data (validated)
  capabilities?: string[];    // NEW: Extracted capabilities from script headers
  resolvedScriptPaths?: Map<string, string>;  // NEW: script name -> full path
  usedByApplications?: string[];  // NEW: Applications that use this template
}

export interface ITemplateTraceEntry {
  name: string;
  path: string;
  origin:
    | "application-local"
    | "application-json"
    | "shared-local"
    | "shared-json"
    | "unknown";
  isShared: boolean;
  skipped: boolean;
  conditional: boolean;
}

export interface IParameterTraceEntry {
  id: string;
  name: string;
  required?: boolean;
  default?: string | number | boolean;
  template?: string;
  templatename?: string;
  source:
    | "user_input"
    | "template_output"
    | "template_properties"
    | "default"
    | "missing";
  sourceTemplate?: string;
  sourceKind?: "outputs" | "properties";
}

export interface ITemplateTraceInfo {
  application: string;
  task: TaskType;
  localDir: string;
  jsonDir: string;
  appLocalDir?: string;
  appJsonDir?: string;
}

export interface ITemplateProcessorLoadResult {
  commands: ICommand[];
  parameters: IParameterWithTemplate[];
  resolvedParams: IResolvedParam[];
  webuiTemplates: string[];
  application?: IApplication;  // Full application data (incl. parent)
  processedTemplates?: IProcessedTemplate[];  // List of all processed templates
  templateTrace?: ITemplateTraceEntry[];
  parameterTrace?: IParameterTraceEntry[];
  traceInfo?: ITemplateTraceInfo;
}
export class TemplateProcessor extends EventEmitter {
  private static enumValuesCache = new Map<
    string,
    (string | { name: string; value: string | number | boolean })[] | null
  >();
  private repositories: FileSystemRepositories;
  resolvedParams: IResolvedParam[] = [];
  constructor(
    private pathes: IConfiguredPathes,
    private storageContext: ContextManager,
    private persistence: IApplicationPersistence & ITemplatePersistence,
    repositories?: FileSystemRepositories,
  ) {
    super();
    this.repositories = repositories ?? new FileSystemRepositories(this.pathes, this.persistence);
  }
  async loadApplication(
    applicationName: string,
    task: TaskType,
    veContext?: IVEContext,
    executionMode?: ExecutionMode,
    initialInputs?: Array<{ id: string; value: string | number | boolean }>,
    enumValuesRefresh?: boolean,
  ): Promise<ITemplateProcessorLoadResult> {
    const readOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", applicationName),
      taskTemplates: [],
    };
    const appLoader = new ApplicationLoader(this.pathes, this.persistence);
    let application = appLoader.readApplicationJson(applicationName, readOpts);
    // Don't throw immediately - collect all errors first (including template processing errors)
    // Errors from readApplicationJson will be added to the errors array during template processing
    // 2. Find the application entry for the requested task
    const appEntry = readOpts.taskTemplates.find((t) => t.task === task);
    if (!appEntry) {
      const message = `Template ${task} not found in ${applicationName} application`;
      throw new VELoadApplicationError(message, applicationName, task, [
        new JsonError(message),
      ]);
    }
    application!.id = applicationName;
    // 3. Get template list for the task
    const templates: (ITemplateReference | string)[] | undefined =
      readOpts.taskTemplates.find((t) => t.task === task)?.templates;

    if (!templates) {
      const appBase = {
        name: applicationName,
        description: application?.description || "",
        icon: application?.icon,
        errors: [`Task ${task} not found in application.json`],
      };
      const err = new JsonError(`Task ${task} not found in application.json`);
      (err as any).application = appBase;
      throw err;
    }

    // 4. Track en parameters
    // Initialize resolvedParams with initialInputs (user-provided parameters)
    // This allows skip_if_all_missing to check user inputs
    const resolvedParams: IResolvedParam[] = [];
    if (initialInputs) {
      for (const input of initialInputs) {
        // Only add non-empty values to resolvedParams
        if (input.value !== null && input.value !== undefined && input.value !== '') {
          // IResolvedParam requires 'id' and 'template'
          // We use "user_input" as template name for user-provided parameters
          // This allows skip_if_all_missing to find user inputs
          resolvedParams.push({
            id: input.id,
            template: "user_input",
          });
        }
      }
    }
    const enumValueInputs = initialInputs
      ? initialInputs.filter(
          (input) =>
            input.value !== null &&
            input.value !== undefined &&
            input.value !== "",
        )
      : undefined;
    // 5. Process each template
    // Start with errors from readApplicationJson (e.g., duplicate templates)
    const errors: IJsonError[] = readOpts.error.details ? [...readOpts.error.details] : [];
    let outParameters: IParameterWithTemplate[] = [];
    let outCommands: ICommand[] = [];
    let webuiTemplates: string[] = [];
    const processedTemplates = new Map<string, IProcessedTemplate>();
    const templateReferences = new Map<string, Set<string>>();  // template -> set of referenced templates
    const outputSources = new Map<string, { template: string; kind: "outputs" | "properties" }>();
    
    for (const tmpl of templates) {
      let ptOpts: IProcessTemplateOpts = {
        application: applicationName,
        template: tmpl,
        templatename: this.extractTemplateName(tmpl),
        resolvedParams,
        visitedTemplates: new Set<string>(),
        parameters: outParameters,
        commands: outCommands,
        errors,
        requestedIn: task,
        webuiTemplates,
        executionMode: executionMode !== undefined ? executionMode : determineExecutionMode(),
        ...(enumValueInputs && enumValueInputs.length > 0
          ? { enumValueInputs }
          : {}),
        enumValuesRefresh: enumValuesRefresh === true,
        processedTemplates,
        templateReferences,
        outputSources,
      };
      if (veContext !== undefined) {
        ptOpts.veContext = veContext;
      }
      await this.#processTemplate(ptOpts);
    }
    
    const processedTemplatesArray = this.buildProcessedTemplatesArray(
      processedTemplates,
      templateReferences,
    );

    const templateTrace = this.buildTemplateTrace(processedTemplatesArray);
    const parameterTrace = this.buildParameterTrace(
      outParameters,
      resolvedParams,
      outputSources,
    );
    const traceInfo = this.buildTraceInfo(applicationName, task);
    // Save resolvedParams for getUnresolvedParameters
    this.resolvedParams = resolvedParams;
    if (errors.length > 0) {
      const appBase = {
        name: applicationName,
        description: application?.description || "",
        icon: application?.icon,
        errors: errors.map((d: any) => d?.passed_message || d?.message || String(d)),
      };
      const primaryMessage =
        errors.length === 1
          ? String(
              (errors[0] as any)?.passed_message ??
                (errors[0] as any)?.message ??
                "Template processing error",
            )
          : "Template processing error";

      const err = new VEConfigurationError(primaryMessage, applicationName, errors);
      (err as any).application = appBase;
      throw err;
    }
    return {
      parameters: outParameters,
      commands: outCommands,
      resolvedParams: resolvedParams,
      webuiTemplates: webuiTemplates,
      application: application,
      processedTemplates: processedTemplatesArray,
      templateTrace,
      parameterTrace,
      traceInfo,
    };
  }
  /**
   * Check if a template should be skipped due to missing parameters or property conditions.
   * Returns true if:
   * - skip_if_property_set is set and the specified parameter is set (exists in resolvedParams)
   * - skip_if_all_missing is set and ALL specified parameters are missing,
   *   AND there are no other required parameters that are unresolved
   */
  #shouldSkipTemplate(
    tmplData: ITemplate,
    resolvedParams: IResolvedParam[],
  ): { shouldSkip: boolean; reason?: "property_set" | "all_missing" } {
    // Check skip_if_property_set logic first (highest priority)
    if (tmplData.skip_if_property_set) {
      const resolved = resolvedParams.find((p) => p.id === tmplData.skip_if_property_set);
      if (resolved) {
        // Parameter is set, skip the template
        return { shouldSkip: true, reason: "property_set" };
      }
    }
    
    // Check skip_if_all_missing logic
    if (tmplData.skip_if_all_missing && tmplData.skip_if_all_missing.length > 0) {
      // Check if ALL parameters in skip_if_all_missing are missing (not resolved yet)
      // A parameter is considered missing if it's not in resolvedParams
      // (meaning it hasn't been provided as an output from a previous template)
      // Skip only if ALL parameters in skip_if_all_missing are missing.
      let allSkipParamsMissing = true;
      for (const paramId of tmplData.skip_if_all_missing) {
        const resolved = resolvedParams.find((p) => p.id === paramId);
        
        // If at least one parameter is resolved, don't skip
        if (resolved) {
          allSkipParamsMissing = false;
          break;
        }
      }
      
      // If not all skip parameters are missing, don't skip
      if (!allSkipParamsMissing) {
        return { shouldSkip: false };
      }
      
      // Now check if there are any other required parameters that are unresolved
      // If there are, we should NOT skip (will cause an error instead)
      if (tmplData.parameters) {
        for (const param of tmplData.parameters) {
          // Skip parameters that are in skip_if_all_missing (we already checked those)
          if (tmplData.skip_if_all_missing.includes(param.id)) {
            continue;
          }
          
          // If this is a required parameter and it's not resolved, don't skip
          if (param.required === true) {
            const resolved = resolvedParams.find((p) => p.id === param.id);
            if (!resolved) {
              // Required parameter is missing, don't skip (will cause error)
              return { shouldSkip: false };
            }
          }
        }
      }
      
      // All skip parameters are missing AND no other required parameters are unresolved
      return { shouldSkip: true, reason: "all_missing" };
    }
    
    // No skip conditions met
    return { shouldSkip: false };
  }

  async #validateAndAddParameters(
    opts: IProcessTemplateOpts,
    tmplData: ITemplate,
    templateName: string,
    templateRef: TemplateRef,
  ): Promise<void> {
    // Custom validation: 'if' must refer to another parameter name, not its own
    if (tmplData.parameters) {
      const paramNames = tmplData.parameters.map((p) => p.id);
      for (const param of tmplData.parameters) {
        if (
          param.if &&
          (param.if === param.id || !paramNames.includes(param.if))
        ) {
          opts.errors?.push(
            new JsonError(
              `Parameter '${param.name}': 'if' must refer to another parameter name in the same template (not itself).`,
            ),
          );
        }
      }
    }

    // Add all parameters (no duplicates)
    for (const param of tmplData.parameters ?? []) {
      if (!opts.parameters.some((p) => p.id === param.id)) {
        // Resolve description from markdown if not in JSON
        let description = param.description;
        if (!description || description.trim() === "") {
          // Try param.name first, then param.id
          let mdSection = this.resolveMarkdownSection(
            templateRef,
            param.name || param.id,
          );
          if (!mdSection && param.name && param.name !== param.id) {
            // Fallback: try param.id if param.name didn't work
            mdSection = this.resolveMarkdownSection(templateRef, param.id);
          }

          if (mdSection) {
            description = mdSection;
          } else {
            // No description in JSON or markdown - this is an error
            opts.errors?.push(
              new JsonError(
                `Parameter '${param.id}' in template '${this.extractTemplateName(opts.template)}' has no description. ` +
                  `Add 'description' in JSON or create '${this.normalizeTemplateName(templateName)}.md' with '## ${param.name || param.id}' section.`,
              ),
            );
          }
        }

        const pparm: IParameterWithTemplate = {
          ...param,
          description: description ?? "", // Use resolved description (ensure string)
          template: this.extractTemplateName(opts.template),
          templatename: tmplData.name || this.extractTemplateName(opts.template),
        };

        if (param.type === "enum" && (param as any).enumValuesTemplate) {
          // Load enum values from another template (mocked execution):
          const enumTmplName = (param as any).enumValuesTemplate;
          opts.webuiTemplates?.push(enumTmplName);
          const enumValues = await this.resolveEnumValuesTemplate(enumTmplName, opts);
          if (Array.isArray(enumValues) && enumValues.length > 0) {
            // If outputs is an array of {name, value}, use it as enum values
            pparm.enumValues = enumValues;
            // If only one enum value is available and no default is set, use it as default
            if (enumValues.length === 1 && pparm.default === undefined) {
              const singleValue = enumValues[0];
              // Handle both string values and {name, value} objects
              if (typeof singleValue === "string") {
                pparm.default = singleValue;
              } else if (
                typeof singleValue === "object" &&
                singleValue !== null &&
                "value" in singleValue
              ) {
                pparm.default = (singleValue as any).value;
              }
            }
          }
        }

        opts.parameters.push(pparm);
      }
    }
  }

  private extractTemplateName(template: ITemplateReference | string): string {
    if (typeof template === "string") {
      return template;
    } else {
      return template.name;
    }
  }

  private normalizeTemplateName(templateName: string): string {
    return templateName.replace(/\.json$/i, "");
  }

  private buildTemplateTracePath(ref: TemplateRef): string {
    const normalized = this.normalizeTemplateName(ref.name);
    const filename = `${normalized}.json`;
    if (ref.scope === "shared") {
      const origin = ref.origin ?? "json";
      return `${origin}/shared/templates/${filename}`;
    }
    const origin = ref.origin ?? "json";
    const appId = ref.applicationId ?? "unknown-app";
    return `${origin}/applications/${appId}/templates/${filename}`;
  }

  private resolveTemplate(
    applicationId: string,
    templateName: string,
  ): { template: ITemplate; ref: TemplateRef } | null {
    const ref = this.repositories.resolveTemplateRef(applicationId, templateName);
    if (!ref) return null;
    const template = this.repositories.getTemplate(ref);
    if (!template) return null;
    return { template, ref };
  }

  private resolveScriptContent(
    applicationId: string,
    scriptName: string,
  ): { content: string | null; ref: ScriptRef | null } {
    const appRef: ScriptRef = { name: scriptName, scope: "application", applicationId };
    const appContent = this.repositories.getScript(appRef);
    if (appContent !== null) return { content: appContent, ref: appRef };
    const sharedRef: ScriptRef = { name: scriptName, scope: "shared" };
    const sharedContent = this.repositories.getScript(sharedRef);
    return { content: sharedContent, ref: sharedContent !== null ? sharedRef : null };
  }

  private resolveScriptPath(ref: ScriptRef | null): string | null {
    if (!ref) return null;
    return this.repositories.resolveScriptPath(ref);
  }

  private resolveLibraryContent(
    applicationId: string,
    libraryName: string,
  ): { content: string | null; ref: ScriptRef | null } {
    const appRef: ScriptRef = { name: libraryName, scope: "application", applicationId };
    const appContent = this.repositories.getScript(appRef);
    if (appContent !== null) return { content: appContent, ref: appRef };
    const sharedRef: ScriptRef = { name: libraryName, scope: "shared" };
    const sharedContent = this.repositories.getScript(sharedRef);
    return { content: sharedContent, ref: sharedContent !== null ? sharedRef : null };
  }

  private resolveLibraryPath(ref: ScriptRef | null): string | null {
    if (!ref) return null;
    return this.repositories.resolveLibraryPath(ref);
  }

  private resolveMarkdownSection(
    ref: TemplateRef,
    sectionName: string,
  ): string | null {
    if (ref.scope !== "shared" && ref.applicationId === undefined) {
      return null;
    }
    const markdownRef: MarkdownRef = {
      templateName: this.normalizeTemplateName(ref.name),
      scope: ref.scope,
      ...(ref.applicationId !== undefined
        ? { applicationId: ref.applicationId }
        : {}),
    };
    return this.repositories.getMarkdownSection(markdownRef, sectionName);
  }

  private normalizeEnumValueInputs(
    inputs?: { id: string; value: IParameterValue }[],
  ): { id: string; value: IParameterValue }[] {
    if (!inputs || inputs.length === 0) return [];
    return inputs
      .filter((item) => item && typeof item.id === "string")
      .map((item) => ({ id: item.id, value: item.value }))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private buildEnumValuesCacheKey(
    enumTemplate: string,
    veContext: IVEContext | undefined,
    inputs?: { id: string; value: IParameterValue }[],
  ): string {
    const veKey = veContext?.getKey ? veContext.getKey() : "no-ve";
    const normalizedInputs = this.normalizeEnumValueInputs(inputs);
    return `${veKey}::${enumTemplate}::${JSON.stringify(normalizedInputs)}`;
  }

  private async resolveEnumValuesTemplate(
    enumTemplate: string,
    opts: IProcessTemplateOpts,
  ): Promise<(string | { name: string; value: string | number | boolean })[] | null | undefined> {
    if (!opts.veContext) return undefined;

    const cacheKey = this.buildEnumValuesCacheKey(
      enumTemplate,
      opts.veContext,
      opts.enumValueInputs,
    );
    const cached = TemplateProcessor.enumValuesCache.get(cacheKey);

    if (cached !== undefined && !opts.enumValuesRefresh) {
      return cached;
    }

    // Prefer reusing the same processing logic by invoking #processTemplate
    // on the referenced enum template; capture its commands and parse payload.
    const tmpCommands: ICommand[] = [];
    const tmpParams: IParameterWithTemplate[] = [];
    const tmpErrors: IJsonError[] = [];
    const tmpResolved: IResolvedParam[] = [];
    const tmpWebui: string[] = [];
    await this.#processTemplate({
      ...opts,
      template: enumTemplate,
      templatename: enumTemplate,
      commands: tmpCommands,
      parameters: tmpParams,
      errors: tmpErrors,
      resolvedParams: tmpResolved,
      webuiTemplates: tmpWebui,
      parentTemplate: this.extractTemplateName(opts.template),
    });

    // Try executing via VeExecution to respect execution semantics; collect errors
    // Skip execution if veContext is not provided (parameter extraction only)
    if (opts.veContext) {
      try {
        const ve = new VeExecution(
          tmpCommands,
          opts.enumValueInputs ?? [],
          opts.veContext,
          undefined,
          undefined, // sshCommand deprecated - use executionMode instead
          opts.executionMode ?? determineExecutionMode(),
        );
        const rc = await ve.run(null);
        const values =
          rc && Array.isArray(rc.outputs) && rc.outputs.length > 0
            ? rc.outputs
            : null;
        TemplateProcessor.enumValuesCache.set(cacheKey, values);
        return values;
      } catch (e: any) {
        if (opts.enumValuesRefresh && cached !== undefined) {
          return cached;
        }
        const err =
          e instanceof JsonError
            ? e
            : new JsonError(String(e?.message ?? e));
        opts.errors?.push(err);
        this.emit("message", {
          stderr: err.message,
          result: null,
          exitCode: -1,
          command: String(enumTemplate),
          execute_on: undefined,
          index: 0,
        });
      }
    }

    return cached;
  }

  private buildProcessedTemplatesArray(
    processedTemplates: Map<string, IProcessedTemplate>,
    templateReferences: Map<string, Set<string>>,
  ): IProcessedTemplate[] {
    // Build referencedBy map (reverse of templateReferences)
    const referencedBy = new Map<string, Set<string>>();
    for (const [templateName, refs] of templateReferences.entries()) {
      for (const ref of refs) {
        if (!referencedBy.has(ref)) {
          referencedBy.set(ref, new Set());
        }
        referencedBy.get(ref)!.add(templateName);
      }
    }

    const processedTemplatesArray: IProcessedTemplate[] = [];
    for (const [templateName, templateInfo] of processedTemplates.entries()) {
      const result: IProcessedTemplate = {
        ...templateInfo,
      };
      if (referencedBy.has(templateName)) {
        result.referencedBy = Array.from(referencedBy.get(templateName)!);
      }
      if (templateReferences.has(templateName)) {
        result.references = Array.from(templateReferences.get(templateName)!);
      }
      processedTemplatesArray.push(result);
    }
    return processedTemplatesArray;
  }

  private buildTemplateTrace(
    processedTemplatesArray: IProcessedTemplate[],
  ): ITemplateTraceEntry[] {
    return processedTemplatesArray.map((templateInfo) => {
      const isLocal = templateInfo.path.startsWith("local/");
      const isJson = templateInfo.path.startsWith("json/");
      const origin: ITemplateTraceEntry["origin"] = templateInfo.isShared
        ? (isLocal ? "shared-local" : isJson ? "shared-json" : "unknown")
        : (isLocal ? "application-local" : isJson ? "application-json" : "unknown");

      const displayPath = templateInfo.path;

      return {
        name: templateInfo.name,
        path: displayPath,
        origin,
        isShared: templateInfo.isShared,
        skipped: templateInfo.skipped,
        conditional: templateInfo.conditional,
      };
    });
  }

  private buildParameterTrace(
    outParameters: IParameterWithTemplate[],
    resolvedParams: IResolvedParam[],
    outputSources: Map<string, { template: string; kind: "outputs" | "properties" }>,
  ): IParameterTraceEntry[] {
    return outParameters.map((param) => {
      const resolved = resolvedParams.find((rp) => rp.id === param.id);
      const hasDefault = param.default !== undefined && param.default !== null && param.default !== "";

      const withOptionalFields = (entry: IParameterTraceEntry): IParameterTraceEntry => {
        if (typeof param.required === "boolean") entry.required = param.required;
        if (param.default !== undefined && param.default !== null) entry.default = param.default;
        if (param.template !== undefined) entry.template = param.template;
        if (param.templatename !== undefined) entry.templatename = param.templatename;
        return entry;
      };

      if (resolved) {
        if (resolved.template === "user_input") {
          const entry: IParameterTraceEntry = {
            id: param.id,
            name: param.name,
            source: "user_input",
          };
          entry.sourceTemplate = resolved.template;
          return withOptionalFields(entry);
        }

        const sourceInfo = outputSources.get(param.id);
        const kind = sourceInfo?.kind;
        const entry: IParameterTraceEntry = {
          id: param.id,
          name: param.name,
          source: kind === "properties" ? "template_properties" : "template_output",
        };
        entry.sourceTemplate = sourceInfo?.template ?? resolved.template;
        if (kind) entry.sourceKind = kind;
        return withOptionalFields(entry);
      }

      if (hasDefault) {
        const entry: IParameterTraceEntry = {
          id: param.id,
          name: param.name,
          source: "default",
        };
        return withOptionalFields(entry);
      }

      const entry: IParameterTraceEntry = {
        id: param.id,
        name: param.name,
        source: "missing",
      };
      return withOptionalFields(entry);
    });
  }

  private buildTraceInfo(
    applicationName: string,
    task: TaskType,
  ): ITemplateTraceInfo {
    const appLocalDir = `${this.pathes.localPath}/applications/${applicationName}`;
    const appJsonDir = `${this.pathes.jsonPath}/applications/${applicationName}`;
    return {
      application: applicationName,
      task,
      localDir: this.pathes.localPath,
      jsonDir: this.pathes.jsonPath,
      appLocalDir,
      appJsonDir,
    };
  }
  // Private method to process a template (including nested templates)
  async #processTemplate(opts: IProcessTemplateOpts): Promise<void> {
    opts.visitedTemplates = opts.visitedTemplates ?? new Set<string>();
    opts.errors = opts.errors ?? [];
    // Prevent endless recursion
    if (opts.visitedTemplates.has(this.extractTemplateName(opts.template))) {
      opts.errors.push(
        new JsonError(
          `Endless recursion detected for template: ${opts.template}`,
        ),
      );
      return;
    }
    const templateName = this.extractTemplateName(opts.template);
    opts.visitedTemplates.add(templateName);
    const resolvedTemplate = this.resolveTemplate(opts.application, templateName);
    if (!resolvedTemplate) {
      const msg =
        `Template file not found: ${opts.template}` +
        ` (requested in: ${opts.requestedIn ?? "unknown"}${opts.parentTemplate ? ", parent template: " + opts.parentTemplate : ""})`;
      opts.errors.push(new JsonError(msg));
      this.emit("message", {
        stderr: msg,
        result: null,
        exitCode: -1,
        command: String(opts.templatename || opts.template),
        execute_on: undefined,
        index: 0,
      });
      return;
    }
    const tmplData = resolvedTemplate.template;
    const tmplRef = resolvedTemplate.ref;
    opts.templateRef = tmplRef;
    // Note: outputs on template level are no longer supported
    // All outputs should be defined on command level
    // Properties commands will be handled directly in the resolvedParams section below
    
    // Validate execute_on: required if template has executable commands (script, command, template)
    // Optional if template only has properties commands
    const hasExecutableCommands = tmplData.commands?.some(
      (cmd) => cmd.script !== undefined || cmd.command !== undefined || cmd.template !== undefined
    ) ?? false;
    if (hasExecutableCommands && !tmplData.execute_on) {
      opts.errors.push(
        new JsonError(
          `Template "${this.extractTemplateName(opts.template)}" has executable commands (script, command, or template) but is missing required "execute_on" property.`,
        ),
      );
    }
    
    // Check if template should be skipped due to missing parameters
    // This check happens BEFORE marking outputs, so outputs from previous templates are available
    // but we don't set outputs for skipped templates
    const skipDecision = this.#shouldSkipTemplate(tmplData, opts.resolvedParams);
    const shouldSkip = skipDecision.shouldSkip;
    const skipReason = skipDecision.reason;
    
    // Determine if template is conditional (skip_if_all_missing or skip_if_property_set)
    const isConditional = !!(tmplData.skip_if_all_missing && tmplData.skip_if_all_missing.length > 0) ||
                          !!tmplData.skip_if_property_set;
    
    // Determine if template is shared or app-specific
    const isSharedTemplate = tmplRef.scope === "shared";
    
    // Store template information
    if (opts.processedTemplates) {
      const normalizedName = this.normalizeTemplateName(templateName);
      opts.processedTemplates.set(normalizedName, {
        name: normalizedName,
        path: this.buildTemplateTracePath(tmplRef),
        isShared: isSharedTemplate,
        skipped: shouldSkip,
        conditional: isConditional,
      });
    }
    
    if (shouldSkip) {
      // Replace all commands with "skipped" commands that always exit with 0
      // Only set execute_on if template has it (properties-only templates don't need it)
      for (const cmd of tmplData.commands ?? []) {
        const description =
          skipReason === "property_set"
            ? `Skipped: property '${tmplData.skip_if_property_set}' is set`
            : "Skipped: all required parameters missing";
        const skippedCommand: ICommand = {
          name: `${cmd.name || tmplData.name || "unnamed-template"} (skipped)`,
          command: "exit 0",
          description,
          ...(tmplData.execute_on && { execute_on: tmplData.execute_on }),
        };
        opts.commands.push(skippedCommand);
      }
      // IMPORTANT: Do NOT set outputs when template is skipped
      // This ensures that subsequent templates correctly detect missing parameters
      // IMPORTANT: We intentionally DO add parameters when the skip reason is "all_missing".
      // Rationale: The UI needs to see these parameters even when inputs start empty,
      // while commands/outputs remain skipped.
      if (skipReason === "all_missing") {
        await this.#validateAndAddParameters(opts, tmplData, templateName, tmplRef);
      }
      return; // Exit early, don't process this template further
    }
    
    // Mark outputs as resolved AFTER confirming template is not skipped
    // This ensures that outputs are only set for templates that actually execute
    // Allow overwriting outputs if template only has properties commands (explicit value setting)
    // Prevent overwriting outputs from different templates with scripts/commands (prevents conflicts)
    const currentTemplateName = this.extractTemplateName(opts.template);
    
    // Collect all outputs from all commands (including properties commands)
    const allOutputIds = new Set<string>();
    const outputIdsFromOutputs = new Set<string>();
    const outputIdsFromProperties = new Set<string>();
    const duplicateIds = new Set<string>();
    const seenIds = new Set<string>();
    
    // Collect outputs from command.outputs
    for (const cmd of tmplData.commands ?? []) {
      if (cmd.outputs) {
        for (const output of cmd.outputs) {
          const id = typeof output === "string" ? output : output.id;
          if (seenIds.has(id)) {
            duplicateIds.add(id);
          } else {
            seenIds.add(id);
            allOutputIds.add(id);
            outputIdsFromOutputs.add(id);
          }
        }
      }
      
      // Extract outputs from properties commands
      // If a command has properties, all IDs in properties are automatically outputs
      if (cmd.properties !== undefined) {
        const propertyIds: string[] = [];
        const propertyIdsInCommand = new Set<string>();
        
        if (Array.isArray(cmd.properties)) {
          // Array of {id, value} objects - check for duplicates within the array
          for (const prop of cmd.properties) {
            if (prop && typeof prop === "object" && prop.id) {
              if (propertyIdsInCommand.has(prop.id)) {
                duplicateIds.add(prop.id);
              } else {
                propertyIdsInCommand.add(prop.id);
                propertyIds.push(prop.id);
              }
            }
          }
        } else if (cmd.properties && typeof cmd.properties === "object" && cmd.properties.id) {
          // Single object with id and value
          propertyIds.push(cmd.properties.id);
        }
        
        // Add property IDs as outputs and check for duplicates across commands
        for (const propId of propertyIds) {
          if (seenIds.has(propId)) {
            duplicateIds.add(propId);
          } else {
            seenIds.add(propId);
            allOutputIds.add(propId);
            outputIdsFromProperties.add(propId);
          }
        }
      }
    }
    
    // Check for duplicates and throw error if found
    if (duplicateIds.size > 0) {
      const duplicateList = Array.from(duplicateIds).join(", ");
      opts.errors.push(
        new JsonError(
          `Duplicate output/property IDs found in template "${currentTemplateName}": ${duplicateList}. Each ID must be unique within a template.`,
        ),
      );
      return; // Don't process further if duplicates found
    }
    
    // Note: outputs on template level are no longer supported
    // All outputs should be defined on command level
    
    // Add all collected outputs to resolvedParams
    // Check for conflicts: if another template in the same task already set this output ID, it's an error
    // UNLESS at least one of the templates is conditional (skip_if_all_missing or skip_if_property_set)
    // In that case, only one template will execute in practice, so it's not a real conflict
    for (const outputId of allOutputIds) {
      const existing = opts.resolvedParams.find((p) => p.id === outputId);
      if (undefined == existing) {
        // Parameter not yet resolved, add it
        opts.resolvedParams.push({
          id: outputId,
          template: currentTemplateName,
        });
        if (opts.outputSources) {
          opts.outputSources.set(outputId, {
            template: currentTemplateName,
            kind: outputIdsFromProperties.has(outputId) ? "properties" : "outputs",
          });
        }
      } else {
        // Output ID already set by another template - check if this is a real conflict
        const conflictingTemplate = existing.template;
        if (conflictingTemplate === "user_input") {
          // User input only defines parameters, not outputs. Allow current template to set outputs.
          const existingIndex = opts.resolvedParams.findIndex((p) => p.id === outputId);
          if (existingIndex !== -1) {
            opts.resolvedParams[existingIndex] = {
              id: outputId,
              template: currentTemplateName,
            };
          }
          if (opts.outputSources) {
            opts.outputSources.set(outputId, {
              template: currentTemplateName,
              kind: outputIdsFromProperties.has(outputId) ? "properties" : "outputs",
            });
          }
          continue;
        }
        
        // Check if the conflicting template is conditional
        let conflictingTemplateIsConditional = false;
        let conflictingTemplateSetsOutput = true; // Default: assume it sets output (since it's in resolvedParams)
        if (opts.processedTemplates) {
          const normalizedConflictingName = this.normalizeTemplateName(conflictingTemplate);
          const conflictingTemplateInfo = opts.processedTemplates.get(normalizedConflictingName);
          if (conflictingTemplateInfo) {
            conflictingTemplateIsConditional = conflictingTemplateInfo.conditional || false;
            
            // Check if the conflicting template actually sets this ID as an output
            // If it only defines it as a parameter (not as output), it's not a conflict
            try {
              const conflictingResolved = this.resolveTemplate(opts.application, conflictingTemplate);
              const conflictingTmplData = conflictingResolved?.template ?? null;
              if (!conflictingTmplData) {
                // If we can't load the template, assume it sets output (conservative approach)
                conflictingTemplateSetsOutput = true;
              } else {
                // Check if the conflicting template sets this ID as output (in outputs or properties)
                conflictingTemplateSetsOutput = false;
                for (const cmd of conflictingTmplData.commands ?? []) {
                  // Check outputs
                  if (cmd.outputs) {
                    for (const output of cmd.outputs) {
                      const id = typeof output === "string" ? output : output.id;
                      if (id === outputId) {
                        conflictingTemplateSetsOutput = true;
                        break;
                      }
                    }
                  }
                  // Check properties (properties are automatically outputs)
                  if (cmd.properties !== undefined) {
                    if (Array.isArray(cmd.properties)) {
                      for (const prop of cmd.properties) {
                        if (prop && typeof prop === "object" && prop.id === outputId) {
                          conflictingTemplateSetsOutput = true;
                          break;
                        }
                      }
                    } else if (cmd.properties && typeof cmd.properties === "object" && cmd.properties.id === outputId) {
                      conflictingTemplateSetsOutput = true;
                    }
                  }
                  if (conflictingTemplateSetsOutput) break;
                }
              }
            } catch {
              // If we can't load the template, assume it sets output (conservative approach)
              conflictingTemplateSetsOutput = true;
            }
          }
        }
        
        // If the conflicting template only defines it as a parameter (not as output), it's not a conflict
        // The parameter will be resolved by the current template's output, and it will be ignored in the UI
        if (!conflictingTemplateSetsOutput) {
          // Allow the conflict - conflicting template only defines parameter, current template sets output
          // Update the resolvedParams to use the current template (last one wins)
          const existingIndex = opts.resolvedParams.findIndex((p) => p.id === outputId);
          if (existingIndex !== -1) {
            opts.resolvedParams[existingIndex] = {
              id: outputId,
              template: currentTemplateName,
            };
          }
          if (opts.outputSources) {
            opts.outputSources.set(outputId, {
              template: currentTemplateName,
              kind: outputIdsFromProperties.has(outputId) ? "properties" : "outputs",
            });
          }
        } else if (isConditional || conflictingTemplateIsConditional) {
          // If at least one template is conditional, it's not a real conflict
          // because in practice only one will execute (the other will be skipped)
          // Allow the conflict - at least one template is conditional, so only one will execute
          // Update the resolvedParams to use the current template (last one wins)
          const existingIndex = opts.resolvedParams.findIndex((p) => p.id === outputId);
          if (existingIndex !== -1) {
            opts.resolvedParams[existingIndex] = {
              id: outputId,
              template: currentTemplateName,
            };
          }
          if (opts.outputSources) {
            opts.outputSources.set(outputId, {
              template: currentTemplateName,
              kind: outputIdsFromProperties.has(outputId) ? "properties" : "outputs",
            });
          }
        } else {
          // Both templates are non-conditional and both set the output - this is a real conflict
          opts.errors.push(
            new JsonError(
              `Output/property ID "${outputId}" is set by multiple templates in the same task: "${conflictingTemplate}" and "${currentTemplateName}". Each output ID can only be set once per task.`,
            ),
          );
        }
      }
    }

    await this.#validateAndAddParameters(opts, tmplData, templateName, tmplRef);

    // Add commands or process nested templates

    for (const cmd of tmplData.commands ?? []) {
      // Set command name from template name if command name is missing or empty
      // This applies to all command types: script, command, template, and properties
      // This is especially important for properties-only commands which often don't have a name field
      if (!cmd.name || (typeof cmd.name === "string" && cmd.name.trim() === "")) {
        cmd.name = `${tmplData.name || "unnamed-template"}`;
      }
      if (cmd.template !== undefined) {
        // Track template reference
        if (opts.templateReferences) {
          const currentTemplateName = this.normalizeTemplateName(templateName);
          const referencedTemplateName = this.normalizeTemplateName(cmd.template);
          if (!opts.templateReferences.has(currentTemplateName)) {
            opts.templateReferences.set(currentTemplateName, new Set());
          }
          opts.templateReferences.get(currentTemplateName)!.add(referencedTemplateName);
        }
        
        await this.#processTemplate({
          ...opts,
          template: cmd.template,
          parentTemplate: templateName,
        });
      } else if (cmd.script !== undefined) {
        const scriptValidator = new ScriptValidator();
        const scriptResolution = this.resolveScriptContent(opts.application, cmd.script);
        scriptValidator.validateScriptContent(
          cmd,
          opts.application,
          opts.errors,
          opts.parameters,
          opts.resolvedParams,
          scriptResolution.content,
          opts.requestedIn,
          opts.parentTemplate,
        );
        const scriptPath = this.resolveScriptPath(scriptResolution.ref);
        
        // Validate and resolve library path if specified
        const commandWithLibrary: ICommand = {
          ...cmd,
          script: scriptPath || cmd.script,
          ...(scriptResolution.content !== null
            ? { scriptContent: scriptResolution.content }
            : {}),
          ...(tmplData.execute_on && { execute_on: tmplData.execute_on }),
        };
        
        if (cmd.library !== undefined) {
          const libraryResolution = this.resolveLibraryContent(opts.application, cmd.library);
          scriptValidator.validateLibraryContent(
            cmd.library,
            opts.errors,
            libraryResolution.content,
            opts.requestedIn,
            opts.parentTemplate,
          );
          const libraryPath = this.resolveLibraryPath(libraryResolution.ref);
          if (libraryResolution.content !== null) {
            commandWithLibrary.libraryContent = libraryResolution.content;
          }
          if (libraryPath) {
            commandWithLibrary.libraryPath = libraryPath;
          }
        }
        
        opts.commands.push(commandWithLibrary);
      } else if (cmd.command !== undefined) {
        const scriptValidator = new ScriptValidator();
        scriptValidator.validateCommand(
          cmd,
          opts.errors,
          opts.parameters,
          opts.resolvedParams,
          opts.requestedIn,
          opts.parentTemplate,
        );
        const commandToAdd: ICommand = {
          ...cmd,
          ...(tmplData.execute_on && { execute_on: tmplData.execute_on }),
        };
        opts.commands.push(commandToAdd);
      } else {
        // Handle properties-only commands or other command types
        // Ensure name is set (should already be set above, but ensure it's preserved)
        // Properties-only commands don't need execute_on (they don't execute anything)
        const commandToAdd: ICommand = {
          ...cmd,
          name: cmd.name || tmplData.name || "unnamed-template",
          ...(tmplData.execute_on && { execute_on: tmplData.execute_on }),
        };
        opts.commands.push(commandToAdd);
      }
    }
  }
  async getUnresolvedParameters(
    application: string,
    task: TaskType,
    veContext?: IVEContext,
  ): Promise<IParameter[]> {
    const loaded = await this.loadApplication(application, task, veContext);
    if (loaded.parameterTrace && loaded.parameterTrace.length > 0) {
      const traceById = new Map(
        loaded.parameterTrace.map((entry) => [entry.id, entry]),
      );
      return loaded.parameters.filter((param) => {
        const trace = traceById.get(param.id);
        return trace ? trace.source === "missing" : true;
      });
    }

    // Fallback: Only parameters whose id is not in resolvedParams.param
    return loaded.parameters.filter(
      (param) =>
        undefined ==
        loaded.resolvedParams.find(
          (rp) => rp.id == param.id && rp.template != param.template,
        ),
    );
  }

  async getParameters(
    application: string,
    task: TaskType,
    veContext?: IVEContext,
  ): Promise<IParameter[]> {
    const loaded = await this.loadApplication(application, task, veContext);
    return loaded.parameters;
  }
}
