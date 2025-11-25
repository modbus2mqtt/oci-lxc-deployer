import fs from "fs";
import * as path from "path";
import { IParameter, IApplicationWeb, TaskType } from "@src/types.mjs";
import { IJsonErrorDetails, JsonError } from "./jsonvalidator.mjs";
import { IConfiguredPathes } from "@src/proxmoxconftypes.mjs";
import { TemplateProcessor } from "@src/templateprocessor.mjs";

export interface IApplicationBase {
  name: string;
  extends?: string;
  description?: string;
  icon?: string;
}
// Interface generated from application.schema.json
export type IApplicationSchema = IApplicationBase & {
  [key in TaskType]?: string[];
};

interface IApplication extends IApplicationSchema {
  id: string;
}
export interface IReadApplicationOptions {
  applicationHierarchy: string[];
  application?: IApplication;
  appPath?: string;
  error: ProxmoxConfigurationError;
  taskTemplates: {
    task: string;
    templates: string[];
  }[];
}
// Interface generated from template.schema.json
export interface ITemplateSchema {}

export class ProxmoxConfigurationError extends JsonError {
  constructor(application: string, details?: IJsonErrorDetails[]) {
    super(application, details);
    this.name = "ProxmoxConfigurationError";
    this.filename = application;
  }
}
export class ProxmoxLoadApplicationError extends JsonError {
  constructor(
    application: string,
    task: string,
    details?: IJsonErrorDetails[],
  ) {
    super(application, details);
    this.name = "ProxmoxLoadApplicationError";
    this.filename = application + "/" + (task ? task : "");
  }
}
class ProxmoxConfiguration implements IConfiguredPathes {
  /**
   * Liest die application.json für eine Anwendung, unterstützt Vererbung und Template-Listen-Manipulation.
   * @param application Name der Anwendung (ggf. mit json: Präfix)
   * @param opts Optionen mit applicationHierarchy und templates
   */

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
    public schemaPath: string,
    public jsonPath: string,
    public localPath: string,
  ) {}

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
          const templateProcessor = new TemplateProcessor(this);
          templateProcessor.loadApplication(appName, "installation");
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
}

export { ProxmoxConfiguration };
