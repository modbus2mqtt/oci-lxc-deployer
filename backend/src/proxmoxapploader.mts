import { ProxmoxConfigurationError } from "@src/proxmoxconfiguration.mjs";
import { IApplication, IConfiguredPathes } from "@src/proxmoxconftypes.mjs";
import path from "path";
import { JsonValidator } from "./jsonvalidator.mjs";
import fs from "fs";

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
export class ApplicationLoader {
  constructor(private pathes: IConfiguredPathes) {}
  /**
   * Liest die application.json für eine Anwendung, unterstützt Vererbung und Template-Listen-Manipulation.
   * @param application Name der Anwendung (ggf. mit json: Präfix)
   * @param opts Optionen mit applicationHierarchy und templates
   */
  public readApplicationJson(
    application: string,
    opts: IReadApplicationOptions,
  ) {
    let appPath: string | undefined;
    let appFile: string | undefined;
    let appName = application;

    if (application.startsWith("json:")) {
      appName = application.replace(/^json:/, "");
      appPath = path.join(this.pathes.jsonPath, "applications", appName);
      appFile = path.join(appPath, "application.json");
      if (!fs.existsSync(appFile))
        throw new Error(`application.json not found for ${application}`);
    } else {
      // Zuerst local, dann json
      let localPath = path.join(
        this.pathes.localPath,
        "applications",
        application,
        "application.json",
      );
      let jsonPath = path.join(
        this.pathes.jsonPath,
        "applications",
        application,
        "application.json",
      );
      if (fs.existsSync(localPath)) {
        appFile = localPath;
        appPath = path.dirname(localPath);
      } else if (fs.existsSync(jsonPath)) {
        appFile = jsonPath;
        appPath = path.dirname(jsonPath);
      } else {
        throw new Error(`application.json not found for ${application}`);
      }
    }
    if (opts.applicationHierarchy.includes(appPath)) {
      throw new Error(
        `Cyclic inheritance detected for application: ${appName}`,
      );
    }
    // Datei lesen und validieren
    const validator = JsonValidator.getInstance(this.pathes.schemaPath);
    let appData: IApplication;
    try {
      appData = validator.serializeJsonFileWithSchema<IApplication>(
        appFile,
        path.join(this.pathes.schemaPath, "application.schema.json"),
      );
      // Save the first application in the hierarchy
      if (!opts.application) {
        opts.application = appData;
        opts.appPath = appPath;
      }
      // first application is first in hierarchy
      opts.applicationHierarchy.push(appPath);

      // Rekursive Vererbung
      if (appData.extends) {
        try {
          this.readApplicationJson(appData.extends, opts);
        } catch (e: Error | any) {
          if (opts.error && Array.isArray(opts.error.details)) {
            opts.error.details.push(e);
          }
        }
      }
      this.processTemplates(appData, opts);
      // application in Hierarchie eintragen
    } catch (e: Error | any) {
      opts.error.details?.push(e);
    }
  }

  private processTemplates(
    appData: IApplication,
    opts: IReadApplicationOptions,
  ) {
    const taskKeys = [
      "installation",
      "backup",
      "restore",
      "uninstall",
      "update",
      "upgrade",
    ];
    for (const key of taskKeys) {
      const list = (appData as any)[key];
      let taskEntry = opts.taskTemplates.find((t) => t.task === key);
      if (!taskEntry) {
        taskEntry = { task: key, templates: [] };
        opts.taskTemplates.push(taskEntry);
      }
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (typeof entry === "string") {
            if (!taskEntry.templates.includes(entry)) {
              taskEntry.templates.push(entry);
            }
          } else if (typeof entry === "object" && entry !== null) {
            const name = entry.name;
            if (!name) continue;
            if (entry.before) {
              const idx = taskEntry.templates.indexOf(entry.before);
              if (idx !== -1) {
                taskEntry.templates.splice(idx, 0, name);
              } else if (!taskEntry.templates.includes(name)) {
                taskEntry.templates.push(name);
              }
            } else if (entry.after) {
              const idx = taskEntry.templates.indexOf(entry.after);
              if (idx !== -1) {
                taskEntry.templates.splice(idx + 1, 0, name);
              } else if (!taskEntry.templates.includes(name)) {
                taskEntry.templates.push(name);
              }
            } else if (!taskEntry.templates.includes(name)) {
              taskEntry.templates.push(name);
            }
          }
        }
      }
    }
  }
}
