import path from "path";
import { IJsonErrorDetails, JsonValidator } from "@src/jsonvalidator.mjs";
import {
  IReadApplicationOptions,
  ProxmoxLoadApplicationError,
} from "@src/proxmoxconfiguration.mjs";
import {
  IConfiguredPathes,
  ProxmoxConfigurationError,
} from "@src/proxmoxconftypes.mjs";
import { TaskType, ITemplate, ICommand, IParameter } from "@src/types.mjs";
import { ApplicationLoader } from "@src/proxmoxapploader.mjs";
import fs from "fs";
import { ProxmoxScriptValidator } from "@src/proxmoxscriptvalidator.mjs";

interface ProxmoxProcessTemplateOpts {
  application: string;
  template: string;
  resolvedParams: Set<string>;
  parameters: IParameter[];
  commands: ICommand[];
  visitedTemplates?: Set<string>;
  errors?: IJsonErrorDetails[];
  requestedIn?: string | undefined;
  parentTemplate?: string | undefined;
  templatePathes: string[];
  scriptPathes: string[];
}
export interface ITemplateProcessorLoadResult {
  commands: ICommand[];
  parameters: IParameter[];
  resolvedParams: Set<string>;
}

export class TemplateProcessor {
  resolvedParams: Set<string> = new Set();
  constructor(private pathes: IConfiguredPathes) {}
  loadApplication(
    applicationName: string,
    task: TaskType,
  ): ITemplateProcessorLoadResult {
    const readOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new ProxmoxConfigurationError(applicationName),
      taskTemplates: [],
    };
    const appLoader = new ApplicationLoader(this.pathes);
    appLoader.readApplicationJson(applicationName, readOpts);
    if (readOpts.error.details && readOpts.error.details.length > 0) {
      throw new ProxmoxLoadApplicationError(
        applicationName,
        task,
        readOpts.error.details,
      );
    }
    const appEntry = readOpts.taskTemplates.find((t) => t.task === task);
    if (!appEntry) {
      throw new ProxmoxLoadApplicationError(applicationName, task, [
        new Error(`Task ${task} not found in application.json`),
      ]);
    }
    if (!readOpts.application) {
      throw new ProxmoxLoadApplicationError(applicationName, task, [
        new Error(`Application data not found for ${applicationName}`),
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
      const err = new Error(`Task ${task} not found in application.json`);
      (err as any).application = appBase;
      throw err;
    }

    // 4. Track resolved parameters
    const resolvedParams = new Set<string>();
    const templatePathes = readOpts.applicationHierarchy.map((appDir) =>
      path.join(appDir, "templates"),
    );
    const scriptPathes = readOpts.applicationHierarchy.map((appDir) =>
      path.join(appDir, "scripts"),
    );
    templatePathes.push(path.join(this.pathes.jsonPath, "shared", "templates"));
    scriptPathes.push(path.join(this.pathes.jsonPath, "shared", "scripts"));
    // 5. Process each template
    const errors: IJsonErrorDetails[] = [];
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
    // Speichere resolvedParams für getUnresolvedParameters
    this.resolvedParams = resolvedParams;
    if (errors.length > 0) {
      if (errors.length === 1 && errors[0]) {
        // Only one error: throw it directly (as string or error object)
        throw errors[0];
      } else {
        const err = new ProxmoxConfigurationError(applicationName, errors);
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
  #processTemplate(opts: ProxmoxProcessTemplateOpts): void {
    opts.visitedTemplates = opts.visitedTemplates ?? new Set<string>();
    opts.errors = opts.errors ?? [];
    // Prevent endless recursion
    if (opts.visitedTemplates.has(opts.template)) {
      opts.errors.push(
        new Error(`Endless recursion detected for template: ${opts.template}`),
      );
      return;
    }
    opts.visitedTemplates.add(opts.template);
    const tmplPath = this.findInPathes(opts.templatePathes, opts.template);
    if (!tmplPath) {
      opts.errors.push(
        new Error(
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
        path.join(this.pathes.schemaPath, "template.schema.json"),
      );
    } catch (e: any) {
      opts.errors.push(e);
      return;
    }
    // Mark outputs as resolved BEFORE adding parameters
    if (Array.isArray(tmplData.outputs)) {
      for (const out of tmplData.outputs) {
        opts.resolvedParams.add(out);
      }
    }

    // Add all parameters (no duplicates)
    if (Array.isArray(tmplData.parameters)) {
      for (const param of tmplData.parameters) {
        if (!opts.parameters.some((p) => p.name === param.name)) {
          if (tmplData.name) param.template = tmplData.name;
          opts.parameters.push(param);
        }
      }
    }

    // Add commands or process nested templates
    if (Array.isArray(tmplData.commands)) {
      // Add dummy parameters for all resolvedParams not already in parameters
      for (const resolved of opts.resolvedParams) {
        if (!opts.parameters.some((p) => p.name === resolved)) {
          opts.parameters.push({ name: resolved, type: "string" });
        }
      }
      for (const cmd of tmplData.commands) {
        if (cmd.name === undefined || (cmd.name.trim() === "" && tmplData)) {
          cmd.name = `${tmplData.name || "unnamed-template"}`;
        }
        switch (cmd.type) {
          case "template":
            if (cmd.execute) {
              this.#processTemplate({
                ...opts,
                template: cmd.execute,
                parentTemplate: opts.template,
              });
            }
            break;
          case "script": {
            const scriptValidator = new ProxmoxScriptValidator();
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
            // Set execute to the full script path (if found)
            const scriptPath = this.findInPathes(
              opts.scriptPathes,
              cmd.execute,
            );
            opts.commands.push({
              ...cmd,
              execute: scriptPath || cmd.execute,
              execute_on: tmplData.execute_on,
            });
            break;
          }
          case "command":
            const scriptValidator = new ProxmoxScriptValidator();
            scriptValidator.validateCommand(
              cmd,
              opts.errors,
              opts.parameters,
              opts.resolvedParams,
              opts.requestedIn,
              opts.parentTemplate,
            );
            opts.commands.push({ ...cmd, execute_on: tmplData.execute_on });
            break;
          default:
            opts.commands.push({ ...cmd, execute_on: tmplData.execute_on });
            break;
        }
      }
    }
  }
  findInPathes(pathes: string[], name: string) {
    // Suche in allen templatePathes nach der ersten existierenden Template-Datei
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
    resolvedParams: Set<string>,
  ): IParameter[] {
    return parameters.filter((param) => !resolvedParams.has(param.name));
  }
}
