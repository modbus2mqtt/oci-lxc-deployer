import path from "node:path";
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
} from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { ApplicationLoader } from "@src/apploader.mjs";
import fs from "fs";
import { ScriptValidator } from "@src/scriptvalidator.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { VeExecution } from "./ve-execution.mjs";
import { TemplatePathResolver } from "./template-path-resolver.mjs";
export interface ITemplateReference {
  name: string;
  before?: string[];
  after?: string[];
}
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
  templatePathes: string[];
  scriptPathes: string[];
  webuiTemplates: string[];
  veContext?: IVEContext;
  sshCommand: string | undefined;
  processedTemplates?: Map<string, IProcessedTemplate>;  // NEU: Sammelt Template-Informationen
  templateReferences?: Map<string, Set<string>>;  // NEU: Template-Referenzen (template -> referenzierte Templates)
}
export interface IParameterWithTemplate extends IParameter {
  template: string;
}
export interface IProcessedTemplate {
  name: string;              // Template-Name (ohne .json)
  path: string;              // Vollständiger Pfad zur Template-Datei
  isShared: boolean;         // true = shared template, false = app-specific
  skipped: boolean;          // true = alle Commands geskippt
  conditional: boolean;       // true = skip_if_all_missing oder optional
  referencedBy?: string[];    // Templates, die diesen Template referenzieren
  references?: string[];      // Templates, die von diesem Template referenziert werden
  templateData?: ITemplate;   // NEU: Vollständige Template-Daten (validiert)
  capabilities?: string[];    // NEU: Extrahierte Capabilities aus Script-Headern
  resolvedScriptPaths?: Map<string, string>;  // NEU: script name -> full path
  usedByApplications?: string[];  // NEU: Applications, die diesen Template verwenden
}

export interface ITemplateProcessorLoadResult {
  commands: ICommand[];
  parameters: IParameterWithTemplate[];
  resolvedParams: IResolvedParam[];
  webuiTemplates: string[];
  application?: IApplication;  // Vollständige Application-Daten (inkl. Parent)
  processedTemplates?: IProcessedTemplate[];  // Liste aller verarbeiteten Templates
}
export class TemplateProcessor extends EventEmitter {
  resolvedParams: IResolvedParam[] = [];
  constructor(
    private pathes: IConfiguredPathes,
    private storageContext: StorageContext = StorageContext.getInstance(),
  ) {
    super();
  }
  async loadApplication(
    applicationName: string,
    task: TaskType,
    veContext: IVEContext,
    sshCommand?: string,
    initialInputs?: Array<{ id: string; value: string | number | boolean }>,
  ): Promise<ITemplateProcessorLoadResult> {
    const readOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", applicationName),
      taskTemplates: [],
    };
    const appLoader = new ApplicationLoader(this.pathes);
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
    const templatePathes = TemplatePathResolver.buildTemplatePathes(
      readOpts.applicationHierarchy,
      this.pathes,
    );
    const scriptPathes = TemplatePathResolver.buildScriptPathes(
      readOpts.applicationHierarchy,
      this.pathes,
    );
    // 5. Process each template
    // Start with errors from readApplicationJson (e.g., duplicate templates)
    const errors: IJsonError[] = readOpts.error.details ? [...readOpts.error.details] : [];
    let outParameters: IParameterWithTemplate[] = [];
    let outCommands: ICommand[] = [];
    let webuiTemplates: string[] = [];
    const processedTemplates = new Map<string, IProcessedTemplate>();
    const templateReferences = new Map<string, Set<string>>();  // template -> set of referenced templates
    
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
        templatePathes,
        scriptPathes,
        webuiTemplates,
        veContext,
        sshCommand,
        processedTemplates,
        templateReferences,
      };
      await this.#processTemplate(ptOpts);
    }
    
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
    
    // Convert processedTemplates Map to Array and add referencedBy/references
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
    // Save resolvedParams for getUnresolvedParameters
    this.resolvedParams = resolvedParams;
    if (errors.length > 0) {
      if (errors.length === 1 && errors[0]) {
        // Only one error: throw it directly (as string or error object)
        throw errors[0];
      } else {
        const err = new VEConfigurationError(
          "Template processing error",
          applicationName,
          errors,
        );
        throw err;
      }
    }
    return {
      parameters: outParameters,
      commands: outCommands,
      resolvedParams: resolvedParams,
      webuiTemplates: webuiTemplates,
      application: application,
      processedTemplates: processedTemplatesArray,
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
  ): boolean {
    // Check skip_if_property_set logic first (highest priority)
    if (tmplData.skip_if_property_set) {
      const resolved = resolvedParams.find((p) => p.id === tmplData.skip_if_property_set);
      if (resolved) {
        // Parameter is set, skip the template
        return true;
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
        return false;
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
              return false;
            }
          }
        }
      }
      
      // All skip parameters are missing AND no other required parameters are unresolved
      return true;
    }
    
    // No skip conditions met
    return false;
  }

  private extractTemplateName(template: ITemplateReference | string): string {
    if (typeof template === "string") {
      return template;
    } else {
      return template.name;
    }
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
    const tmplPath = TemplatePathResolver.findInPathes(
      opts.templatePathes,
      templateName,
    );
    if (!tmplPath) {
      const msg =
        `Template file not found: ${opts.template} (searched in: ${opts.templatePathes.join(", ")}` +
        ', requested in: ${opts.requestedIn ?? "unknown"}${opts.parentTemplate ? ", parent template: " + opts.parentTemplate : ""})';
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
    let tmplData: ITemplate;
    // Validate template against schema
    try {
      // Use the JsonValidator factory (singleton)
      const validator = this.storageContext.getJsonValidator();
      tmplData = validator.serializeJsonFileWithSchema<ITemplate>(
        tmplPath,
        "template.schema.json",
        // Check for icon.png in the application directory
      );
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
    } catch (e: any) {
      opts.errors.push(e);
      this.emit("message", {
        stderr: e?.message ?? String(e),
        result: null,
        exitCode: -1,
        command: String(opts.templatename || opts.template),
        execute_on: undefined,
        index: 0,
      });
      return;
    }
    
    // Check if template should be skipped due to missing parameters
    // This check happens BEFORE marking outputs, so outputs from previous templates are available
    // but we don't set outputs for skipped templates
    const shouldSkip = this.#shouldSkipTemplate(
      tmplData,
      opts.resolvedParams,
    );
    
    // Determine if template is conditional (skip_if_all_missing or skip_if_property_set)
    const isConditional = !!(tmplData.skip_if_all_missing && tmplData.skip_if_all_missing.length > 0) ||
                          !!tmplData.skip_if_property_set;
    
    // Determine if template is shared or app-specific
    const sharedTemplatesPath = path.join(this.pathes.jsonPath, "shared", "templates");
    const isSharedTemplate = tmplPath.startsWith(sharedTemplatesPath);
    
    // Store template information
    if (opts.processedTemplates) {
      const normalizedName = TemplatePathResolver.normalizeTemplateName(templateName);
      opts.processedTemplates.set(normalizedName, {
        name: normalizedName,
        path: tmplPath,
        isShared: isSharedTemplate,
        skipped: shouldSkip,
        conditional: isConditional,
      });
    }
    
    if (shouldSkip) {
      // Replace all commands with "skipped" commands that always exit with 0
      // Only set execute_on if template has it (properties-only templates don't need it)
      for (const cmd of tmplData.commands ?? []) {
        const skippedCommand: ICommand = {
          name: `${cmd.name || tmplData.name || "unnamed-template"} (skipped)`,
          command: "exit 0",
          description: `Skipped: all required parameters missing`,
          ...(tmplData.execute_on && { execute_on: tmplData.execute_on }),
        };
        opts.commands.push(skippedCommand);
      }
      // IMPORTANT: Do NOT set outputs when template is skipped
      // This ensures that subsequent templates correctly detect missing parameters
      // IMPORTANT: Do NOT add parameters when template is skipped
      // This ensures that parameters from skipped templates don't appear in unresolved parameters
      return; // Exit early, don't process this template further
    }
    
    // Mark outputs as resolved AFTER confirming template is not skipped
    // This ensures that outputs are only set for templates that actually execute
    // Allow overwriting outputs if template only has properties commands (explicit value setting)
    // Prevent overwriting outputs from different templates with scripts/commands (prevents conflicts)
    const currentTemplateName = this.extractTemplateName(opts.template);
    // Check if template only has properties commands (no scripts or command strings)
    const hasOnlyProperties = tmplData.commands?.every(
      (cmd) => cmd.properties !== undefined && cmd.script === undefined && cmd.command === undefined && cmd.template === undefined
    ) ?? false;
    
    // Collect all outputs from all commands (including properties commands)
    const allOutputIds = new Set<string>();
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
      } else {
        // Output ID already set by another template - check if this is a real conflict
        const conflictingTemplate = existing.template;
        
        // Check if the conflicting template is conditional
        let conflictingTemplateIsConditional = false;
        let conflictingTemplateSetsOutput = true; // Default: assume it sets output (since it's in resolvedParams)
        if (opts.processedTemplates) {
          const normalizedConflictingName = TemplatePathResolver.normalizeTemplateName(conflictingTemplate);
          const conflictingTemplateInfo = opts.processedTemplates.get(normalizedConflictingName);
          if (conflictingTemplateInfo) {
            conflictingTemplateIsConditional = conflictingTemplateInfo.conditional || false;
            
            // Check if the conflicting template actually sets this ID as an output
            // If it only defines it as a parameter (not as output), it's not a conflict
            try {
              const conflictingTmplPath = conflictingTemplateInfo.path;
              const validator = this.storageContext.getJsonValidator();
              const conflictingTmplData = validator.serializeJsonFileWithSchema<ITemplate>(
                conflictingTmplPath,
                "template.schema.json",
              );
              
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
            } catch (e) {
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

    // Custom validation: 'if' must refer to another parameter name, not its own
    // Only validate and add parameters if template is NOT skipped
    if (tmplData.parameters) {
      const paramNames = tmplData.parameters.map((p) => p.id);
      for (const param of tmplData.parameters) {
        if (
          param.if &&
          (param.if === param.id || !paramNames.includes(param.if))
        ) {
          opts.errors.push(
            new JsonError(
              `Parameter '${param.name}': 'if' must refer to another parameter name in the same template (not itself).`,
            ),
          );
        }
      }
    }
    
    // Add all parameters (no duplicates)
    // Only add parameters if template is NOT skipped
    for (const param of tmplData.parameters ?? []) {
      if (!opts.parameters.some((p) => p.id === param.id)) {
        const pparm: IParameterWithTemplate = {
          ...param,
          template: this.extractTemplateName(opts.template),
          templatename:
            tmplData.name || this.extractTemplateName(opts.template),
        };
        if (param.type === "enum" && (param as any).enumValuesTemplate) {
          // Load enum values from another template (mocked execution):
          const enumTmplName = (param as any).enumValuesTemplate;
          opts.webuiTemplates?.push(enumTmplName);
          // Prefer reusing the same processing logic by invoking #processTemplate
          // on the referenced enum template; capture its commands and parse payload.
          const tmpCommands: ICommand[] = [];
          const tmpParams: IParameterWithTemplate[] = [];
          const tmpErrors: IJsonError[] = [];
          const tmpResolved: IResolvedParam[] = [];
          const tmpWebui: string[] = [];
          await this.#processTemplate({
            ...opts,
            template: enumTmplName,
            templatename: enumTmplName,
            commands: tmpCommands,
            parameters: tmpParams,
            errors: tmpErrors,
            resolvedParams: tmpResolved,
            webuiTemplates: tmpWebui,
            parentTemplate: this.extractTemplateName(opts.template),
          });
          // Try executing via VeExecution to respect execution semantics; collect errors
          // Skip execution if this is a validation context (dummy VE context)
          const isValidationContext = opts.veContext?.host === "validation-dummy";
          if (!isValidationContext) {
            try {
              const context = opts.veContext!;
              const ve = new VeExecution(
                tmpCommands,
                [],
                context ?? null,
                undefined,
                opts.sshCommand ?? "ssh",
              );
              const rc = await ve.run(null);
              if (rc && Array.isArray(rc.outputs) && rc.outputs.length > 0) {
                // If outputs is an array of {name, value}, use it as enum values
                pparm.enumValues = rc.outputs;
                // If only one enum value is available and no default is set, use it as default
                if (rc.outputs.length === 1 && pparm.default === undefined) {
                  const singleValue = rc.outputs[0];
                  // Handle both string values and {name, value} objects
                  if (typeof singleValue === "string") {
                    pparm.default = singleValue;
                  } else if (typeof singleValue === "object" && singleValue !== null && "value" in singleValue) {
                    pparm.default = singleValue.value;
                  }
                }
              }
            } catch (e: any) {
              const err =
                e instanceof JsonError
                  ? e
                  : new JsonError(String(e?.message ?? e));
              opts.errors?.push(err);
              this.emit("message", {
                stderr: err.message,
                result: null,
                exitCode: -1,
                command: String(enumTmplName),
                execute_on: undefined,
                index: 0,
              });
            }
          } else {
            // During validation, we skip enum value execution but still validate that the template exists
            // The enum template will be validated separately as part of the application validation
          }
        }

        opts.parameters.push(pparm);
      }
    }

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
          const currentTemplateName = TemplatePathResolver.normalizeTemplateName(templateName);
          const referencedTemplateName = TemplatePathResolver.normalizeTemplateName(cmd.template);
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
        scriptValidator.validateScript(
          cmd,
          opts.application,
          opts.errors,
          opts.parameters,
          opts.resolvedParams,
          opts.requestedIn,
          opts.parentTemplate,
          opts.scriptPathes,
        );
        const scriptPath = TemplatePathResolver.findInPathes(opts.scriptPathes, cmd.script);
        
        // Validate and resolve library path if specified
        const commandWithLibrary: ICommand = {
          ...cmd,
          script: scriptPath || cmd.script,
          ...(tmplData.execute_on && { execute_on: tmplData.execute_on }),
        };
        
        if (cmd.library !== undefined) {
          scriptValidator.validateLibrary(
            cmd.library,
            opts.errors,
            opts.requestedIn,
            opts.parentTemplate,
            opts.scriptPathes,
          );
          const libraryPath = TemplatePathResolver.findInPathes(opts.scriptPathes, cmd.library);
          if (!libraryPath) {
            opts.errors.push(
              new JsonError(
                `Library file not found: ${cmd.library} (for script: ${cmd.script}, requested in: ${opts.requestedIn ?? "unknown"}${opts.parentTemplate ? ", parent template: " + opts.parentTemplate : ""})`,
              ),
            );
          } else {
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
  /**
   * Extracts capabilities from script header comments.
   * Similar to extractCapabilitiesFromScriptHeader in documentation-generator.
   */
  #extractCapabilitiesFromScriptHeader(scriptPath: string): string[] {
    const capabilities: string[] = [];
    
    try {
      const scriptContent = fs.readFileSync(scriptPath, "utf-8");
      const lines = scriptContent.split("\n");
      
      // Look for "This script" section in header comments
      let inHeader = false;
      let foundThisScript = false;
      
      for (let i = 0; i < lines.length && i < 50; i++) {
        const line = lines[i]?.trim() || "";
        
        // Start of header (after shebang)
        if (line.startsWith("#") && !line.startsWith("#!/")) {
          inHeader = true;
        }
        
        // Look for "This script" or "This library" line
        if (inHeader && (line.includes("This script") || line.includes("This library"))) {
          foundThisScript = true;
        }
        
        // Look for numbered list of capabilities (e.g., "# 1. Validates...", "2. Creates...")
        if (foundThisScript && inHeader) {
          // Match lines like "# 1. Validates..." or "1. Validates..."
          const numberedMatch = line.match(/^#*\s*\d+\.\s+(.+)/);
          if (numberedMatch && numberedMatch[1]) {
            let capability = numberedMatch[1].trim();
            // Remove leading # if present
            capability = capability.replace(/^#+\s*/, "").trim();
            if (capability.length > 0) {
              capabilities.push(capability);
            }
          }
        }
        
        // Stop at first non-comment line after header
        if (inHeader && !line.startsWith("#") && line.length > 0 && !line.startsWith("exec >&2")) {
          break;
        }
      }
    } catch {
      // Ignore errors reading script
    }
    
    return capabilities;
  }

  // Removed findInPathes - now using TemplatePathResolver.findInPathes
  async getUnresolvedParameters(
    application: string,
    task: TaskType,
    veContest?: IVEContext,
  ): Promise<IParameter[]> {
    const loaded = await this.loadApplication(application, task, veContest!);
    // Only parameters whose id is not in resolvedParams.param
    return loaded.parameters.filter(
      (param) =>
        undefined ==
        loaded.resolvedParams.find(
          (rp) => rp.id == param.id && rp.template != param.template,
        ),
    );
  }
}
