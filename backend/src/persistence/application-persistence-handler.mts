import path from "path";
import fs from "fs";
import {
  IApplication,
  IConfiguredPathes,
  IReadApplicationOptions,
  VEConfigurationError,
} from "../backend-types.mjs";
import { IApplicationWeb } from "../types.mts";
import { ITemplateReference } from "../templateprocessor.mjs";
import { JsonValidator } from "../jsonvalidator.mjs";
import { JsonError } from "../jsonvalidator.mjs";

/**
 * Handles application-specific persistence operations
 * Separated from main FileSystemPersistence for better organization
 */
export class ApplicationPersistenceHandler {
  // Application Caches
  private appNamesCache: {
    json: Map<string, string> | null;
    local: Map<string, string> | null;
  } = {
    json: null,
    local: null,
  };

  private applicationsListCache: IApplicationWeb[] | null = null;
  private applicationCache: Map<string, { data: IApplication; mtime: number }> =
    new Map();

  constructor(
    private pathes: IConfiguredPathes,
    private jsonValidator: JsonValidator,
  ) {}

  getAllAppNames(): Map<string, string> {
    // JSON: Einmalig laden
    if (this.appNamesCache.json === null) {
      this.appNamesCache.json = this.scanApplicationsDir(this.pathes.jsonPath);
    }

    // Local: Aus Cache (wird durch fs.watch invalidiert)
    if (this.appNamesCache.local === null) {
      this.appNamesCache.local = this.scanApplicationsDir(
        this.pathes.localPath,
      );
    }

    // Merge: Local hat Priorität
    const result = new Map(this.appNamesCache.json);
    for (const [name, appPath] of this.appNamesCache.local) {
      result.set(name, appPath);
    }
    return result;
  }

  listApplicationsForFrontend(): IApplicationWeb[] {
    // Cache prüfen (wird durch fs.watch invalidiert)
    if (this.applicationsListCache === null) {
      this.applicationsListCache = this.buildApplicationList();
    }
    return this.applicationsListCache;
  }

  /**
   * Baut Application-Liste auf (ohne Templates zu laden!)
   */
  private buildApplicationList(): IApplicationWeb[] {
    const applications: IApplicationWeb[] = [];
    const allApps = this.getAllAppNames();

    // Für jede Application: application.json laden (OHNE Templates!)
    for (const [applicationName, appPath] of allApps) {
      const readOpts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", applicationName),
        taskTemplates: [], // Wird nur für Validierung verwendet, nicht geladen
      };

      try {
        const app = this.readApplication(applicationName, readOpts);
        app.description = app.description || "No description available";
        applications.push(app as IApplicationWeb);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e: Error | any) {
        // Errors werden unten behandelt
      }

      if (
        readOpts.error.details &&
        readOpts.error.details.length > 0 &&
        applications.length > 0
      ) {
        applications[applications.length - 1]!.errors = readOpts.error.details;
      }
    }

    return applications;
  }

  readApplication(
    applicationName: string,
    opts: IReadApplicationOptions,
  ): IApplication {
    let appPath: string | undefined;
    let appFile: string | undefined;
    let appName = applicationName;

    // Handle json: prefix
    if (applicationName.startsWith("json:")) {
      appName = applicationName.replace(/^json:/, "");
      appPath = path.join(this.pathes.jsonPath, "applications", appName);
      appFile = path.join(appPath, "application.json");
      if (!fs.existsSync(appFile)) {
        throw new Error(`application.json not found for ${applicationName}`);
      }
    } else {
      // First check local, then json
      const localPath = path.join(
        this.pathes.localPath,
        "applications",
        applicationName,
        "application.json",
      );
      const jsonPath = path.join(
        this.pathes.jsonPath,
        "applications",
        applicationName,
        "application.json",
      );
      if (fs.existsSync(localPath)) {
        appFile = localPath;
        appPath = path.dirname(localPath);
      } else if (fs.existsSync(this.pathes.jsonPath)) {
        appFile = jsonPath;
        appPath = path.dirname(jsonPath);
      } else {
        throw new Error(`application.json not found for ${applicationName}`);
      }
    }

    // Check for cyclic inheritance
    if (opts.applicationHierarchy.includes(appPath)) {
      throw new Error(
        `Cyclic inheritance detected for application: ${appName}`,
      );
    }

    // Check cache first (only for local apps)
    const isLocal = appPath.startsWith(this.pathes.localPath);
    if (isLocal) {
      const appFileStat = fs.statSync(appFile);
      const mtime = appFileStat.mtimeMs;
      const cached = this.applicationCache.get(applicationName);
      if (cached && cached.mtime === mtime) {
        // Return cached, but need to process inheritance/templates
        // For now, we'll reload to ensure consistency
        // TODO: Optimize to reuse cached data with proper inheritance handling
      }
    }

    // Read and validate file
    let appData: IApplication;
    try {
      try {
        appData = this.jsonValidator.serializeJsonFileWithSchema<IApplication>(
          appFile,
          "application",
        );
      } catch (e: Error | any) {
        appData = {
          id: applicationName,
          name: applicationName,
        };
        this.addErrorToOptions(opts, e);
      }

      appData.id = appName;

      // Save the first application in the hierarchy
      if (!opts.application) {
        opts.application = appData;
        opts.appPath = appPath;
      }
      // First application is first in hierarchy
      opts.applicationHierarchy.push(appPath);

      // Recursive inheritance - load parent first to get icon data
      if (appData.extends) {
        try {
          const parent = this.readApplication(appData.extends, opts);
          // Inherit icon if not found
          if (!appData.icon && parent.icon) {
            appData.icon = parent.icon;
            appData.iconContent = parent.iconContent;
            appData.iconType = parent.iconType;
          }
        } catch (e: Error | any) {
          this.addErrorToOptions(opts, e);
        }
      }

      // Check for icon in the application directory (supports .png and .svg)
      let icon = appData?.icon ? appData.icon : "icon.png";
      let iconFound = false;
      if (appPath) {
        const iconPath = path.join(appPath, icon);
        if (fs.existsSync(iconPath)) {
          appData.icon = icon;
          appData.iconContent = fs.readFileSync(iconPath, {
            encoding: "base64",
          });
          // Determine MIME type based on file extension
          const ext = path.extname(icon).toLowerCase();
          appData.iconType = ext === ".svg" ? "image/svg+xml" : "image/png";
          iconFound = true;
          // Store icon data for inheritance
          (opts as any).inheritedIcon = icon;
          (opts as any).inheritedIconContent = appData.iconContent;
          (opts as any).inheritedIconType = appData.iconType;
        }
      }

      // If no icon found and we have inherited icon data from parent, use it
      if (!iconFound && (opts as any).inheritedIconContent) {
        appData.icon = (opts as any).inheritedIcon || "icon.png";
        appData.iconContent = (opts as any).inheritedIconContent;
        appData.iconType = (opts as any).inheritedIconType;
      }

      // Process templates (adds template references to opts.taskTemplates)
      this.processTemplates(appData, opts);

      // Cache only local apps
      if (isLocal) {
        const mtime = fs.statSync(appFile).mtimeMs;
        this.applicationCache.set(applicationName, { data: appData, mtime });
      }

      return appData;
    } catch (e: Error | any) {
      this.addErrorToOptions(opts, e);
    }
    throw opts.error;
  }

  readApplicationIcon(applicationName: string): {
    iconContent: string;
    iconType: string;
  } | null {
    const appPath = this.getAllAppNames().get(applicationName);
    if (!appPath) {
      return null;
    }

    // Try to find icon
    const iconNames = ["icon.png", "icon.svg"];
    for (const iconName of iconNames) {
      const iconPath = path.join(appPath, iconName);
      if (fs.existsSync(iconPath)) {
        const iconContent = fs.readFileSync(iconPath, { encoding: "base64" });
        const ext = path.extname(iconName).toLowerCase();
        const iconType = ext === ".svg" ? "image/svg+xml" : "image/png";
        return { iconContent, iconType };
      }
    }

    return null;
  }

  writeApplication(applicationName: string, application: IApplication): void {
    const appDir = path.join(
      this.pathes.localPath,
      "applications",
      applicationName,
    );
    fs.mkdirSync(appDir, { recursive: true });

    const appFile = path.join(appDir, "application.json");
    fs.writeFileSync(appFile, JSON.stringify(application, null, 2));

    // Invalidate caches (fs.watch wird auch triggern, aber manuell ist sicherer)
    this.invalidateApplicationCache(applicationName);
  }

  deleteApplication(applicationName: string): void {
    const appDir = path.join(
      this.pathes.localPath,
      "applications",
      applicationName,
    );
    fs.rmSync(appDir, { recursive: true, force: true });

    // Invalidate caches
    this.invalidateApplicationCache(applicationName);
  }

  invalidateApplicationCache(applicationName?: string): void {
    this.appNamesCache.local = null;
    this.applicationsListCache = null;
    if (applicationName) {
      this.applicationCache.delete(applicationName);
    } else {
      this.applicationCache.clear();
    }
  }

  invalidateAllCaches(): void {
    this.appNamesCache.json = null;
    this.appNamesCache.local = null;
    this.applicationsListCache = null;
    this.applicationCache.clear();
  }

  // Helper methods

  private scanApplicationsDir(basePath: string): Map<string, string> {
    const apps = new Map<string, string>();
    const appsDir = path.join(basePath, "applications");

    if (!fs.existsSync(appsDir)) return apps;

    const entries = fs.readdirSync(appsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const appJsonPath = path.join(appsDir, entry.name, "application.json");
        if (fs.existsSync(appJsonPath)) {
          apps.set(entry.name, path.join(appsDir, entry.name));
        }
      }
    }

    return apps;
  }

  private addErrorToOptions(
    opts: IReadApplicationOptions | { error: VEConfigurationError },
    error: Error | any,
  ): void {
    if (opts.error && Array.isArray(opts.error.details)) {
      opts.error.details.push(error);
    } else if (opts.error) {
      opts.error.details = [error];
    }
  }

  /**
   * Processes templates from application data and adds them to opts.taskTemplates
   * This is similar to ApplicationLoader.processTemplates
   */
  private processTemplates(
    appData: IApplication,
    opts: IReadApplicationOptions,
  ): void {
    const taskKeys = [
      "installation",
      "backup",
      "restore",
      "uninstall",
      "update",
      "upgrade",
      "webui",
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
            this.addTemplateToTask(entry, taskEntry, key, opts);
          } else if (typeof entry === "object" && entry !== null) {
            const name = (entry as ITemplateReference).name;
            if (!name) continue;
            if (
              (entry as ITemplateReference).before &&
              Array.isArray((entry as ITemplateReference).before) &&
              (entry as ITemplateReference).before!.length > 0
            ) {
              // before is an array, use the first element
              const beforeName = (entry as ITemplateReference).before![0];
              const existingTemplates = taskEntry.templates.map((t) =>
                typeof t === "string" ? t : (t as ITemplateReference).name,
              );
              // Check for duplicates before inserting
              if (existingTemplates.includes(name)) {
                const error = new JsonError(
                  `Template '${name}' appears multiple times in ${key} task. Each template can only appear once per task.`,
                );
                this.addErrorToOptions(opts, error);
                return; // Don't add duplicate
              }
              const idx = existingTemplates.indexOf(beforeName);
              if (idx !== -1) {
                taskEntry.templates.splice(idx, 0, name);
              } else {
                this.addTemplateToTask(name, taskEntry, key, opts);
              }
            } else if (
              (entry as ITemplateReference).after &&
              Array.isArray((entry as ITemplateReference).after) &&
              (entry as ITemplateReference).after!.length > 0
            ) {
              // after is an array, use the first element
              const afterName = (entry as ITemplateReference).after![0];
              const existingTemplates = taskEntry.templates.map((t) =>
                typeof t === "string" ? t : (t as ITemplateReference).name,
              );
              // Check for duplicates before inserting
              if (existingTemplates.includes(name)) {
                const error = new JsonError(
                  `Template '${name}' appears multiple times in ${key} task. Each template can only appear once per task.`,
                );
                this.addErrorToOptions(opts, error);
                return; // Don't add duplicate
              }
              const idx = existingTemplates.indexOf(afterName);
              if (idx !== -1) {
                taskEntry.templates.splice(idx + 1, 0, name);
              } else {
                this.addTemplateToTask(name, taskEntry, key, opts);
              }
            } else {
              this.addTemplateToTask(name, taskEntry, key, opts);
            }
          }
        }
      }
    }
  }

  /**
   * Adds a template to the task entry. Duplicates are not allowed and will cause an error.
   */
  private addTemplateToTask(
    templateName: string,
    taskEntry: { task: string; templates: (ITemplateReference | string)[] },
    taskName: string,
    opts: IReadApplicationOptions,
  ): void {
    // Check for duplicates - duplicates are not allowed
    const templateNameStr =
      typeof templateName === "string" ? templateName : templateName;
    const existingTemplates = taskEntry.templates.map((t) =>
      typeof t === "string" ? t : (t as ITemplateReference).name,
    );
    if (existingTemplates.includes(templateNameStr)) {
      const error = new JsonError(
        `Template '${templateNameStr}' appears multiple times in ${taskName} task. Each template can only appear once per task.`,
      );
      this.addErrorToOptions(opts, error);
      return; // Don't add duplicate
    }
    taskEntry.templates.push(templateName);
  }
}

