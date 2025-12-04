import path from "path";
import { JsonError } from "@src/jsonvalidator.mjs";
import {
  IConfiguredPathes,
  IReadApplicationOptions,
  IResolvedParam,
  VEConfigurationError,
  VELoadApplicationError,
} from "@src/backend-types.mjs";
import {
  TaskType,
  ITemplate,
  ICommand,
  IParameter,
  IJsonError,
} from "@src/types.mjs";
import { ApplicationLoader } from "@src/apploader.mjs";
import fs from "fs";
import { ScriptValidator } from "@src/scriptvalidator.mjs";
import { StorageContext } from "./storagecontext.mjs";

interface IProcessTemplateOpts {
  application: string;
  template: string;
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
}
export interface IParameterWithTemplate extends IParameter {
  template: string;
}
export interface ITemplateProcessorLoadResult {
  commands: ICommand[];
  parameters: IParameterWithTemplate[];
  resolvedParams: IResolvedParam[];
  webuiTemplates: string[];
}
export class TemplateProcessor {
  resolvedParams: IResolvedParam[] = [];
  constructor(
    private pathes: IConfiguredPathes,
    private storageContext: StorageContext = StorageContext.getInstance(),
  ) {}
  loadApplication(
    applicationName: string,
    task: TaskType,
  ): ITemplateProcessorLoadResult {
    const readOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", applicationName),
      taskTemplates: [],
    };
    const appLoader = new ApplicationLoader(this.pathes);
    appLoader.readApplicationJson(applicationName, readOpts);
    if (readOpts.error.details && readOpts.error.details.length > 0) {
      throw new VELoadApplicationError(
        "Load Application error",
        applicationName,
        task,
        readOpts.error.details,
      );
    }
    // 2. Find the application entry for the requested task
    const appEntry = readOpts.taskTemplates.find((t) => t.task === task);
    if (!appEntry) {
      const message = `Template ${task} not found in ${applicationName} application`;
      throw new VELoadApplicationError(message, applicationName, task, [
        new JsonError(message),
      ]);
    }
    if (!readOpts.application) {
      const message = `Application data not found for ${applicationName}`;
      throw new VELoadApplicationError(message, applicationName, task, [
        new JsonError(message),
      ]);
    }
    let application = readOpts.application;
    // Check for icon.png in the application directory
    let icon = application?.icon ? application.icon : "icon.png";
    if (readOpts.appPath) {
      const iconPath = path.join(readOpts.appPath, icon);
      if (fs.existsSync(iconPath)) {
        application!.icon = icon;
      }
    }
    application!.id = applicationName;
    // 3. Get template list for the task
    const templates: string[] | undefined = application?.[task];

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

    // 4. Track resolved parameters
    const resolvedParams: IResolvedParam[] = [];
    const templatePathes = readOpts.applicationHierarchy.map((appDir) =>
      path.join(appDir, "templates"),
    );
    const scriptPathes = readOpts.applicationHierarchy.map((appDir) =>
      path.join(appDir, "scripts"),
    );
    templatePathes.push(path.join(this.pathes.jsonPath, "shared", "templates"));
    scriptPathes.push(path.join(this.pathes.jsonPath, "shared", "scripts"));
    // 5. Process each template
    const errors: IJsonError[] = [];
    let outParameters: IParameterWithTemplate[] = [];
    let outCommands: ICommand[] = [];
    let webuiTemplates: string[] = [];
    for (const tmpl of templates) {
      let ptOpts: IProcessTemplateOpts = {
        application: applicationName,
        template: tmpl,
        templatename: tmpl,
        resolvedParams,
        visitedTemplates: new Set<string>(),
        parameters: outParameters,
        commands: outCommands,
        errors,
        requestedIn: task,
        templatePathes,
        scriptPathes,
        webuiTemplates,
      };
      this.#processTemplate(ptOpts);
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
    };
  }

  // Private method to process a template (including nested templates)
  #processTemplate(opts: IProcessTemplateOpts): void {
    opts.visitedTemplates = opts.visitedTemplates ?? new Set<string>();
    opts.errors = opts.errors ?? [];
    // Prevent endless recursion
    if (opts.visitedTemplates.has(opts.template)) {
      opts.errors.push(
        new JsonError(
          `Endless recursion detected for template: ${opts.template}`,
        ),
      );
      return;
    }
    opts.visitedTemplates.add(opts.template);
    const tmplPath = this.findInPathes(opts.templatePathes, opts.template);
    if (!tmplPath) {
      opts.errors.push(
        new JsonError(
          `Template file not found: ${opts.template} (searched in: ${opts.templatePathes.join(", ")}` +
            ', requested in: ${opts.requestedIn ?? "unknown"}${opts.parentTemplate ? ", parent template: " + opts.parentTemplate : ""})',
        ),
      );
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
      (tmplData.outputs ??= []).forEach((output, index) => {
        if (typeof output === "string") {
          // Convert string to object with id
          (tmplData.outputs as any)[index] = { id: output };
        }
      });
    } catch (e: any) {
      opts.errors.push(e);
      return;
    }
    // Mark outputs as resolved BEFORE adding parameters
    for (const out of tmplData.outputs ?? []) {
      if (undefined == opts.resolvedParams.find((p) => p.id === out.id)) {
        opts.resolvedParams.push({ id: out.id, template: opts.template });
      }
    }

    // Custom validation: 'if' must refer to another parameter name, not its own
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
    for (const param of tmplData.parameters ?? []) {
      if (!opts.parameters.some((p) => p.id === param.id)) {
        const pparm: IParameterWithTemplate = {
          ...param,
          template: opts.template,
          templatename: tmplData.name || opts.template,
        };
        if (param.type === "enum" && (param as any).enumValuesTemplate) {
          // Load enum values from another template
          const enumTmplName = (param as any).enumValuesTemplate;
          opts.webuiTemplates?.push(enumTmplName);
        }

        opts.parameters.push(pparm);
      }
    }

    // Add commands or process nested templates

    for (const cmd of tmplData.commands ?? []) {
      if (cmd.name === undefined || (cmd.name.trim() === "" && tmplData)) {
        cmd.name = `${tmplData.name || "unnamed-template"}`;
        // 5. Process each template
        if (cmd.template !== undefined) {
          this.#processTemplate({
            ...opts,
            template: cmd.template,
            parentTemplate: opts.template,
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
          // Save resolvedParams for getUnresolvedParameters
          const scriptPath = this.findInPathes(opts.scriptPathes, cmd.script);
          opts.commands.push({
            ...cmd,
            script: scriptPath || cmd.script,
            execute_on: tmplData.execute_on,
          });
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
          opts.commands.push({ ...cmd, execute_on: tmplData.execute_on });
        } else {
          opts.commands.push({ ...cmd, execute_on: tmplData.execute_on });
          break;
        }
      }
    }
  }
  findInPathes(pathes: string[], name: string) {
    // Search all templatePathes for the first existing template file
    let tmplPath: string | undefined = undefined;
    for (const basePath of pathes) {
      const candidate = path.join(basePath, name);
      if (fs.existsSync(candidate)) {
        tmplPath = candidate;
        break;
      }
    }
    return tmplPath;
  }
  getUnresolvedParameters(
    parameters: IParameterWithTemplate[],
    resolvedParams: IResolvedParam[],
  ): IParameter[] {
    // Only parameters whose id is not in resolvedParams.param
    return parameters.filter(
      (param) =>
        undefined ==
        resolvedParams.find(
          (rp) => rp.id == param.id && rp.template != param.template,
        ),
    );
  }
}
