import path from "path";
import { JsonError, JsonValidator } from "@src/jsonvalidator.mjs";
import {
  IReadApplicationOptions,
  ProxmoxLoadApplicationError,
} from "@src/ve-configuration.mjs";
import {
  IConfiguredPathes,
  IResolvedParam,
  ProxmoxConfigurationError,
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

interface IProcessTemplateOpts {
  application: string;
  template: string;
  resolvedParams: IResolvedParam[];
  parameters: IParameter[];
  commands: ICommand[];
  visitedTemplates?: Set<string>;
  errors?: IJsonError[];
  requestedIn?: string | undefined;
  parentTemplate?: string | undefined;
  templatePathes: string[];
  scriptPathes: string[];
}
export interface ITemplateProcessorLoadResult {
  commands: ICommand[];
  parameters: IParameter[];
  resolvedParams: IResolvedParam[];
}

export class TemplateProcessor {
  resolvedParams: IResolvedParam[] = [];
  constructor(private pathes: IConfiguredPathes) {}
  loadApplication(
    applicationName: string,
    task: TaskType,
  ): ITemplateProcessorLoadResult {
    const readOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new ProxmoxConfigurationError("", applicationName),
      taskTemplates: [],
    };
    const appLoader = new ApplicationLoader(this.pathes);
    appLoader.readApplicationJson(applicationName, readOpts);
    if (readOpts.error.details && readOpts.error.details.length > 0) {
      throw new ProxmoxLoadApplicationError(
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
      throw new ProxmoxLoadApplicationError(message, applicationName, task, [
        new JsonError(message),
      ]);
    }
    if (!readOpts.application) {
      const message = `Application data not found for ${applicationName}`;
      throw new ProxmoxLoadApplicationError(message, applicationName, task, [
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
    let outParameters: IParameter[] = [];
    let outCommands: ICommand[] = [];
    for (const tmpl of templates) {
      let ptOpts = {
        application: applicationName,
        template: tmpl,
        resolvedParams,
        visitedTemplates: new Set<string>(),
        parameters: outParameters,
        commands: outCommands,
        errors,
        requestedIn: task,
        templatePathes,
        scriptPathes,
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
        const err = new ProxmoxConfigurationError(
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
      // Nutze die JsonValidator-Factory (Singleton)
      const validator = JsonValidator.getInstance(this.pathes.schemaPath);
      tmplData = validator.serializeJsonFileWithSchema<ITemplate>(
        tmplPath,
        "template.schema.json",
        // Check for icon.png in the application directory
      );
    } catch (e: any) {
      opts.errors.push(e);
      return;
    }
    // Mark outputs as resolved BEFORE adding parameters
    for (const out of tmplData.outputs ?? []) {
      if (!opts.resolvedParams.some((p) => p.param === out && p.template === opts.template)) {
        opts.resolvedParams.push({ template: opts.template, param: out });
      }
    }

    // Add all parameters (no duplicates)
    for (const param of tmplData.parameters ?? []) {
      if (!opts.parameters.some((p) => p.id === param.id)) {
        if (tmplData.name) param.template = tmplData.name;
        opts.parameters.push(param);
      }
    }

    // Add commands or process nested templates
    for (const resolved of opts.resolvedParams) {
      if (!opts.parameters.some((p) => p.id === resolved.param)) {
        opts.parameters.push({
          id: resolved.param,
          name: resolved.param,
          type: "string",
        });
      }
    }
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
    parameters: IParameter[],
    resolvedParams: IResolvedParam[],
  ): IParameter[] {
    // Only parameters whose id is not in resolvedParams.param
    return parameters.filter(
      (param) => !resolvedParams.some((rp) => rp.param === param.id),
    );
  }
}
