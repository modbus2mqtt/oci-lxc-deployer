import * as fs from "fs";
import * as path from "path";
import {
  ICommand,
  IParameter,
  IApplicationWeb,
  ITemplate,
  TaskType,
} from "@src/types.mjs";
import { IJsonErrorDetails, JsonError, JsonValidator } from "./jsonvalidator.mjs";

interface ProxmoxProcessTemplateOpts {
  application: string;
  template: string;
  resolvedParams: Set<string>;
  visitedTemplates?: Set<string>;
  errors?: IJsonErrorDetails[];
  requestedIn?: string | undefined;
  parentTemplate?: string | undefined;
  jsonPath: string;
}

// Interface generated from application.schema.json
export interface IApplicationSchema {
  name: string;
  extends?: string;
  description?: string;
  icon?: string;
  installation?: string[];
  backup?: string[];
  restore?: string[];
  uninstall?: string[];
  update?: string[];
  upgrade?: string[];
}
interface IApplication extends IApplicationWeb {
  id: string;
}

// Interface generated from template.schema.json
export interface ITemplateSchema {}

export class ProxmoxConfigurationError extends JsonError {
  
  constructor(  application: string, details?: IJsonErrorDetails[]) {
    super(application,details);
    this.name = "ProxmoxConfigurationError";
    this.message = `'${application}' has errors. ` + (details && details.length > 1? `See details for ${details.length} errors.` : "")
  }
}

class ProxmoxConfiguration {
  /**
   * Finds the absolute path to a script file for a given application and script name.
   * Returns the path if found, otherwise an empty string.
   */
  private findScriptPath(application: string, scriptName: string): string {
    const scriptPathApp = path.join(
      this.jsonPath,
      "applications",
      application,
      "scripts",
      scriptName,
    );
    const scriptPathLocal = path.join(
      this.localPath,
      "applications",
      application,
      "scripts",
      scriptName,
    );
    const scriptPathShared = path.join(
      this.jsonPath,
      "shared",
      "scripts",
      scriptName,
    );
    if (fs.existsSync(scriptPathLocal)) return scriptPathLocal;
    else if (fs.existsSync(scriptPathApp)) return scriptPathApp;
    else if (fs.existsSync(scriptPathShared)) return scriptPathShared;
    return "";
  }

  commands: ICommand[] = [];
  parameters: IParameter[] = [];
  _resolvedParams: Set<string> = new Set();
  static getAllApps(jsonPath: string, localPath: string): Map<string, string> {
    const allApps = new Map<string, string>();
    [localPath, jsonPath].forEach((jPath) => {
      const appsDir = path.join(jPath, "applications");
      if (fs.existsSync(appsDir))
        fs.readdirSync(appsDir)
          .filter(
            (f) =>
              fs.existsSync(path.join(appsDir, f)) &&
              fs.statSync(path.join(appsDir, f)).isDirectory() &&
              fs.existsSync(path.join(appsDir, f, "application.json")),
          )
          .forEach((f) => {
            if (!allApps.has(f)) allApps.set(f, path.join(appsDir, f));
          });
    });
    return allApps;
  }
  constructor(
    private schemaPath: string,
    private jsonPath: string,
    private localPath: string,
  ) {}
  // readApps omitted, as getAllApps is now static

  listApplications(): IApplicationWeb[] {
    const applications: IApplicationWeb[] = [];
    for (const [appName, appDir] of ProxmoxConfiguration.getAllApps(
      this.jsonPath,
      this.localPath,
    )) {
      try {
        const appData = JSON.parse(
          fs.readFileSync(path.join(appDir, "application.json"), "utf-8"),
        );
        let iconBase64: string | undefined = undefined;
        const iconPath = path.join(appDir, "icon.png");
        if (fs.existsSync(iconPath)) {
          const iconBuffer = fs.readFileSync(iconPath);
          iconBase64 = iconBuffer.toString("base64");
        }
        // Try to load the application (including template validation etc.)
        try {
          this.loadApplication(appName, "installation");
          applications.push({
            name: appData.name,
            description: appData.description,
            icon: appData.icon,
            iconContent: iconBase64,
            id: appName,
          });
        } catch (err) {
          // On error: attach application object with errors
          const errorApp = (err as any).application || {
            name: appData.name || appName,
            description: appData.description || "",
            icon: appData.icon,
            errors: [(err as any).message || "Unknown error"],
          };
          applications.push({
            name: errorApp.name,
            description: errorApp.description,
            icon: errorApp.icon,
            iconContent: iconBase64,
            id: appName,
            errors: errorApp.errors,
          } as any);
        }
      } catch (e) {
        // Error parsing application.json
        applications.push({
          name: appName,
          description: "",
          icon: undefined,
          iconContent: undefined,
          id: appName,
          errors: [
            typeof e === "string" ? e : (e as any).message || "Unknown error",
          ],
        } as any);
      }
    }
    return applications;
  }
  loadApplication(applicationName: string, task: TaskType): void {
    // 1. Read application JSON
    const appPath = ProxmoxConfiguration.getAllApps(
      this.jsonPath,
      this.localPath,
    ).get(applicationName);
    if (!appPath) {
      const err = new Error(`Application ${applicationName} not found`);
      throw err;
    }
    const appDataFilePath = path.join(appPath, "application.json");
    if (!fs.existsSync(appDataFilePath)) {
      const err = new Error(`Application file not found: ${appDataFilePath}`);
      throw err;
    }
    const appData = JSON.parse(fs.readFileSync(appDataFilePath, "utf-8"));
    let application: IApplication | undefined;
    // 2. Validate against schema
    try {
      // Nutze die JsonValidator-Factory (Singleton)
      const validator = JsonValidator.getInstance(this.schemaPath);
      application = validator.serializeJsonWithSchema(
        appData,
        path.join(this.schemaPath, "application.schema.json"),
      );
    } catch (err: any) {
      if (err.details && Array.isArray(err.details)) {
        throw err;
      }
      const appBase = {
        name: appData.name || applicationName,
        description: appData.description || "",
        icon: appData.icon,
        errors: err.message,
      };
      const error = new Error(
        appDataFilePath + " does not match schema: " + err.message,
      );
      (error as any).application = appBase;
      throw error;
    }
    // Check for icon.png in the application directory
    let icon = application?.icon ? application.icon : "icon.png";
    const iconPath = path.join(appPath, icon);
    if (fs.existsSync(iconPath)) {
      application!.icon = icon;
    }
    application!.id = applicationName;
    // 3. Get template list for the task
    const templates: string[] | undefined = appData[task];
    if (!templates || !Array.isArray(templates)) {
      const appBase = {
        name: appData.name || applicationName,
        description: appData.description || "",
        icon: appData.icon,
        errors: [`Task ${task} not found or not an array in application.json`],
      };
      const err = new Error(
        `Task ${task} not found or not an array in application.json`,
      );
      (err as any).application = appBase;
      throw err;
    }

    // 4. Track resolved parameters
    const resolvedParams = new Set<string>();

    // 5. Process each template
    const errors: IJsonErrorDetails[] = [];
    for (const tmpl of templates) {
      this.#processTemplate({
        application: applicationName,
        template: tmpl,
        resolvedParams,
        visitedTemplates: new Set<string>(),
        errors,
        requestedIn: task,
        jsonPath: appPath,
      });
    }
    // Speichere resolvedParams für getUnresolvedParameters
    this._resolvedParams = resolvedParams;
    if (errors.length > 0) {
      const appBase = {
        name: appData.name || applicationName,
        description: appData.description || "",
        icon: appData.icon,
        errors,
      };
      if (errors.length === 1 && errors[0]) {
        // Only one error: throw it directly (as string or error object)
        throw errors[0];
      } else {
        const err = new ProxmoxConfigurationError(
          applicationName,
          errors
        );
        throw err;
      }
    }
  }

  // Private method to process a template (including nested templates)
  #processTemplate(opts: ProxmoxProcessTemplateOpts): void {
    opts.visitedTemplates = opts.visitedTemplates ?? new Set<string>();
    opts.errors = opts.errors ?? [];
    // Prevent endless recursion
    if (opts.visitedTemplates.has(opts.template)) {
      opts.errors.push(
        { error: new Error(`Endless recursion detected for template: ${opts.template}`) },
      );
      return;
    }
    opts.visitedTemplates.add(opts.template);
    // Try application-specific templates first, then shared
    let tmplPath = path.join(opts.jsonPath, "templates", opts.template);
    let foundLocation: "application" | "shared" | undefined;
    if (fs.existsSync(tmplPath)) {
      foundLocation = "application";
    } else {
      tmplPath = path.join(
        opts.jsonPath,
        "../../shared",
        "templates",
        opts.template,
      );
      if (fs.existsSync(tmplPath)) {
        foundLocation = "shared";
      } else {
        opts.errors.push(
          { error: new Error(`Template file not found: ${opts.template} (location: ${foundLocation ?? "not found"}, requested in: ${opts.requestedIn ?? "unknown"}${opts.parentTemplate ? ", parent template: " + opts.parentTemplate : ""})`) },
        );
        return;
      }
    }
    let tmplData: ITemplate;
    try {
      tmplData = JSON.parse(fs.readFileSync(tmplPath, "utf-8"));
    } catch (e) {
      opts.errors.push(
        { error: new Error(`Failed to read or parse template ${opts.template} in ${foundLocation}: ${e} (requested in: ${opts.requestedIn ?? "unknown"}${opts.parentTemplate ? ", parent template: " + opts.parentTemplate : ""})`) },
      );
      return;
    }
    // Validate template against schema
    try {
      // Nutze die JsonValidator-Factory (Singleton)
      const validator = JsonValidator.getInstance(this.schemaPath);
      validator.serializeJsonWithSchema(
        tmplData,
        path.join(this.schemaPath, "template.schema.json"),
      );
    } catch (e: any) {
        opts.errors.push({ error: e});
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
        if (!this.parameters.some((p) => p.name === param.name)) {
          if (tmplData.name) param.template = tmplData.name;
          this.parameters.push(param);
        }
      }
    }

    // Add commands or process nested templates
    if (Array.isArray(tmplData.commands)) {
      // Add dummy parameters for all resolvedParams not already in parameters
      for (const resolved of opts.resolvedParams) {
        if (!this.parameters.some((p) => p.name === resolved)) {
          this.parameters.push({ name: resolved, type: "string" });
        }
      }
      for (const cmd of tmplData.commands) {
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
            this.validateScript(
              cmd,
              opts.application,
              opts.errors,
              opts.requestedIn,
              opts.parentTemplate,
            );
            // Set execute to the full script path (if found)
            const scriptPath = this.findScriptPath(
              opts.application,
              cmd.execute,
            );
            this.commands.push({
              ...cmd,
              execute: scriptPath || cmd.execute,
              execute_on: tmplData.execute_on,
            });
            break;
          }
          case "command":
            this.validateCommand(
              cmd,
              opts.errors,
              opts.requestedIn,
              opts.parentTemplate,
            );
            this.commands.push({ ...cmd, execute_on: tmplData.execute_on });
            break;
          default:
            this.commands.push({ ...cmd, execute_on: tmplData.execute_on });
            break;
        }
      }
    }
  }

  /**
   * Checks if the script exists and if all variables are defined as parameters.
   */
  private validateScript(
    cmd: ICommand,
    application: string,
    errors: IJsonErrorDetails[],
    requestedIn?: string,
    parentTemplate?: string,
  ) {
    const scriptPath = this.findScriptPath(application, cmd.execute);
    if (!scriptPath) {
      errors.push(
        { error: new Error(`Script file not found: ${cmd.execute} (searched in: applications/${application}/scripts and shared/scripts, requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`) },
      );
      return;
    }
    // Read script content and check variables
    try {
      const scriptContent = fs.readFileSync(scriptPath, "utf-8");
      const vars = this.extractTemplateVariables(scriptContent);
      for (const v of vars) {
        if (
          !this.parameters.some((p) => p.name === v) &&
          !this._resolvedParams.has(v)
        ) {
          errors.push(
            { error: new Error(`Script ${cmd.execute} uses variable '{{ ${v} }}' but no such parameter is defined (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`) },
          );
        }
      }
    } catch (e) {
      errors.push({ error: new Error(`Failed to read script ${cmd.execute}: ${e}`) });
    }
  }

  /**
   * Checks if all variables in the execute string are defined as parameters.
   */
  private validateCommand(
    cmd: ICommand,
    errors: IJsonErrorDetails[],
    requestedIn?: string,
    parentTemplate?: string,
  ) {
    if (cmd.execute) {
      const vars = this.extractTemplateVariables(cmd.execute);
      for (const v of vars) {
        if (
          !this.parameters.some((p) => p.name === v) &&
          !this._resolvedParams.has(v)
        ) {
          errors.push(
            { error: new Error(`Command uses variable '{{ ${v} }}' but no such parameter is defined (requested in: ${requestedIn ?? "unknown"}${parentTemplate ? ", parent template: " + parentTemplate : ""})`) },
          );
        }
      }
    }
  }

  /**
   * Extracts all {{ var }} placeholders from a string.
   */
  private extractTemplateVariables(str: string): string[] {
    const regex = /{{ *([^}\ ]+) *}}/g;
    const vars = new Set<string>();
    let match;
    while ((match = regex.exec(str)) !== null) {
      vars.add(match[1] || "");
    }
    return Array.from(vars);
  }

  loadConfiguration(configuration: string): void {
    // ...
  }
  getUnresolvedParameters(): IParameter[] {
    return this.parameters.filter(
      (param) => !this._resolvedParams.has(param.name),
    );
  }
  saveConfiguration(configData: any): void {
    // Implementation to save configuration
  }
}

export { ProxmoxConfiguration };
