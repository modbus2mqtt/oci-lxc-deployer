import path from "path";
import fs from "fs";
import {
  IApplication,
  IConfiguredPathes,
  IReadApplicationOptions,
  VEConfigurationError,
} from "../backend-types.mjs";
import { IApplicationWeb } from "../types.mjs";
import { ITemplateReference } from "../backend-types.mjs";
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
    private enableCache: boolean = true,
  ) {}

  getAllAppNames(): Map<string, string> {
    if (!this.enableCache) {
      // Cache disabled: always scan fresh
      const jsonApps = this.scanApplicationsDir(this.pathes.jsonPath);
      const localApps = this.scanApplicationsDir(this.pathes.localPath);
      const result = new Map(jsonApps);
      for (const [name, appPath] of localApps) {
        result.set(name, appPath);
      }
      return result;
    }

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

  /**
   * Returns only local application names mapped to their paths
   * Used for validation when creating new applications - allows creating
   * local applications even if the same ID exists in json directory
   */
  getLocalAppNames(): Map<string, string> {
    if (!this.enableCache) {
      // Cache disabled: always scan fresh
      return this.scanApplicationsDir(this.pathes.localPath);
    }

    // Local: Aus Cache (wird durch fs.watch invalidiert)
    if (this.appNamesCache.local === null) {
      this.appNamesCache.local = this.scanApplicationsDir(
        this.pathes.localPath,
      );
    }

    return new Map(this.appNamesCache.local);
  }

  listApplicationsForFrontend(): IApplicationWeb[] {
    if (!this.enableCache) {
      // Cache disabled: always build fresh
      return this.buildApplicationList();
    }
    // Cache prüfen (wird durch fs.watch invalidiert)
    if (this.applicationsListCache === null) {
      this.applicationsListCache = this.buildApplicationList();
    }
    return this.applicationsListCache;
  }

  /**
   * Baut Application-Liste auf (ohne Templates zu laden!)
   * Jede Application bekommt einen Eintrag, auch wenn fehlerhaft.
   * Fehler werden in der errors Property gesammelt.
   */
  private buildApplicationList(): IApplicationWeb[] {
    const applications: IApplicationWeb[] = [];
    const allApps = this.getAllAppNames();
    const localApps = this.getLocalAppNames();

    // Für jede Application: application.json laden (OHNE Templates!)
    for (const [applicationName] of allApps) {
      const readOpts: IReadApplicationOptions & {
        extendsChain?: string[];
        appSource?: "local" | "json";
      } = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", applicationName),
        taskTemplates: [], // Wird nur für Validierung verwendet, nicht geladen
        extendsChain: [],
      };

      // Determine source: local or json
      const source: "local" | "json" = localApps.has(applicationName)
        ? "local"
        : "json";
      readOpts.appSource = source;

      let appWeb: IApplicationWeb;

      try {
        // Use lightweight version that doesn't process templates
        const app = this.readApplicationLightweight(applicationName, readOpts);

        // Determine framework from extends chain
        const framework = this.determineFramework(readOpts.extendsChain || []);

        appWeb = {
          id: app.id,
          name: app.name,
          description: app.description || "No description available",
          icon: app.icon,
          iconContent: app.iconContent,
          iconType: app.iconType,
          tags: app.tags,
          source,
          framework,
          extends: app.extends,
          stacktype: app.stacktype,
          ...(app.errors &&
            app.errors.length > 0 && {
              errors: app.errors.map((e) => ({
                message: e,
                name: "Error",
                details: undefined,
              })),
            }),
        };
      } catch (e: Error | any) {
        // Loading failed - create minimal entry with error
        appWeb = {
          id: applicationName,
          name: applicationName,
          description: "Failed to load application",
          source,
          errors: [
            {
              name: e?.name || "Error",
              message: e?.message || String(e),
              details: e?.details,
            },
          ],
        };
      }

      // Attach any accumulated errors from readOpts
      if (readOpts.error.details && readOpts.error.details.length > 0) {
        const convertedErrors = readOpts.error.details.map((e) => ({
          name: e?.name || "Error",
          message: e?.message || String(e),
          details: e?.details,
        }));

        if (appWeb.errors) {
          // Merge with existing errors (avoid duplicates)
          appWeb.errors = [...appWeb.errors, ...convertedErrors];
        } else {
          appWeb.errors = convertedErrors;
        }
      }

      applications.push(appWeb);
    }

    return applications;
  }

  /**
   * Determines the framework from the extends chain.
   * Known frameworks: oci-image, docker-compose, npm-nodejs
   * Returns undefined if no known framework is in the chain (native app)
   */
  private determineFramework(extendsChain: string[]): string | undefined {
    const knownFrameworks = ["oci-image", "docker-compose", "npm-nodejs"];
    for (const appId of extendsChain) {
      if (knownFrameworks.includes(appId)) {
        return appId;
      }
    }
    return undefined;
  }

  /**
   * Lightweight version of readApplication that only loads metadata (id, name, description, icon)
   * without processing templates. Used for building the application list for the frontend.
   */
  private readApplicationLightweight(
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
        } as IApplication;
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
        // Track extends chain for framework detection
        const extendsOpts = opts as typeof opts & { extendsChain?: string[] };
        if (extendsOpts.extendsChain) {
          extendsOpts.extendsChain.push(appData.extends);
        }
        try {
          const parent = this.readApplicationLightweight(appData.extends, opts);
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

      // NOTE: We intentionally skip processTemplates() here for performance
      // Templates are only needed when actually installing/configuring an application

      return appData;
    } catch (e: Error | any) {
      this.addErrorToOptions(opts, e);
    }
    throw opts.error;
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
        } as IApplication;
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
        const ext = path.extname(iconName).toLowerCase();
        const iconType = ext === ".svg" ? "image/svg+xml" : "image/png";

        if (ext === ".svg") {
          // For SVG: normalize size to 16x16 before base64 encoding
          const svgContent = fs.readFileSync(iconPath, { encoding: "utf-8" });
          const normalizedSvg = this.normalizeSvgSize(svgContent, 16);
          const iconContent = Buffer.from(normalizedSvg, "utf-8").toString(
            "base64",
          );
          return { iconContent, iconType };
        } else {
          const iconContent = fs.readFileSync(iconPath, { encoding: "base64" });
          return { iconContent, iconType };
        }
      }
    }

    const fallbackSvg = this.generateFallbackIconSvg(applicationName);
    return {
      iconContent: Buffer.from(fallbackSvg, "utf-8").toString("base64"),
      iconType: "image/svg+xml",
    };
  }

  private generateFallbackIconSvg(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = (hash * 31 + seed.charCodeAt(i)) | 0;
    }
    const hue = Math.abs(hash) % 360;
    const hue2 = (hue + 45) % 360;
    const bg = `hsl(${hue}, 65%, 45%)`;
    const fg = `hsl(${hue2}, 70%, 75%)`;
    const size = 96;
    const pad = 12;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 3;
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
      `<rect width="${size}" height="${size}" rx="18" ry="18" fill="${bg}"/>`,
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fg}"/>`,
      `<rect x="${pad}" y="${pad}" width="${size - pad * 2}" height="${size - pad * 2}" rx="14" ry="14" fill="none" stroke="${fg}" stroke-width="6"/>`,
      `</svg>`,
    ].join("");
  }

  /**
   * Normalizes SVG size by replacing width/height attributes with a fixed size.
   * Preserves viewBox for proper scaling.
   */
  private normalizeSvgSize(svgContent: string, size: number): string {
    // Replace width and height attributes in the <svg> tag
    // Handles values with units like "432.071pt" or "100px" or just "100"
    let normalized = svgContent.replace(
      /<svg([^>]*)\swidth\s*=\s*["'][^"']*["']/i,
      `<svg$1 width="${size}"`,
    );
    normalized = normalized.replace(
      /<svg([^>]*)\sheight\s*=\s*["'][^"']*["']/i,
      `<svg$1 height="${size}"`,
    );
    return normalized;
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
    // Installation uses category-based format: { image, pre_start, start, post_start }
    const installationCategories = ["image", "pre_start", "start", "post_start"];
    const installation = (appData as any).installation;
    if (installation && typeof installation === "object") {
      let taskEntry = opts.taskTemplates.find((t) => t.task === "installation");
      if (!taskEntry) {
        taskEntry = { task: "installation", templates: [] };
        opts.taskTemplates.push(taskEntry);
      }

      for (const category of installationCategories) {
        const list = installation[category];
        if (Array.isArray(list)) {
          this.processTemplateList(list, taskEntry, "installation", opts, category);
        }
      }
    }

    // addon-reconfigure uses category-based format: { image, pre_start, start, post_start }
    const addonReconfigure = (appData as any)["addon-reconfigure"];
    if (addonReconfigure && typeof addonReconfigure === "object" && !Array.isArray(addonReconfigure)) {
      let taskEntry = opts.taskTemplates.find((t) => t.task === "addon-reconfigure");
      if (!taskEntry) {
        taskEntry = { task: "addon-reconfigure", templates: [] };
        opts.taskTemplates.push(taskEntry);
      }

      for (const category of installationCategories) {
        const list = addonReconfigure[category];
        if (Array.isArray(list)) {
          this.processTemplateList(list, taskEntry, "addon-reconfigure", opts, category);
        }
      }
    }

    // Other tasks use simple array format
    const otherTaskKeys = [
      "backup",
      "restore",
      "uninstall",
      "update",
      "upgrade",
      "copy-upgrade",
      "copy-rollback",
      "addon",
      "webui",
    ];

    for (const key of otherTaskKeys) {
      const list = (appData as any)[key];
      if (Array.isArray(list)) {
        let taskEntry = opts.taskTemplates.find((t) => t.task === key);
        if (!taskEntry) {
          taskEntry = { task: key, templates: [] };
          opts.taskTemplates.push(taskEntry);
        }
        this.processTemplateList(list, taskEntry, key, opts);
      }
    }
  }

  /**
   * Processes a list of template entries and adds them to the task entry
   * @param category Optional category for shared template resolution (e.g., "image", "pre_start")
   */
  private processTemplateList(
    list: any[],
    taskEntry: { task: string; templates: (ITemplateReference | string)[] },
    taskName: string,
    opts: IReadApplicationOptions,
    category?: string,
  ): void {
    for (const entry of list) {
      if (typeof entry === "string") {
        // Convert string to ITemplateReference with category
        if (category) {
          this.addTemplateToTask({ name: entry, category }, taskEntry, taskName, opts);
        } else {
          this.addTemplateToTask(entry, taskEntry, taskName, opts);
        }
      } else if (typeof entry === "object" && entry !== null) {
        const templateRef = entry as ITemplateReference;
        const name = templateRef.name;
        if (!name) continue;
        // Attach category if not already specified
        if (category && !templateRef.category) {
          templateRef.category = category;
        }
        // Handle before: support both string and array
        const beforeValue = templateRef.before;
        if (beforeValue) {
          const beforeName =
            Array.isArray(beforeValue) && beforeValue.length > 0
              ? beforeValue[0]
              : typeof beforeValue === "string"
                ? beforeValue
                : null;

          if (beforeName) {
            const existingTemplates = taskEntry.templates.map((t) =>
              typeof t === "string" ? t : (t as ITemplateReference).name,
            );
            // Check for duplicates before inserting
            if (existingTemplates.includes(name)) {
              const error = new JsonError(
                `Template '${name}' appears multiple times in ${taskName} task. Each template can only appear once per task.`,
              );
              this.addErrorToOptions(opts, error);
              return; // Don't add duplicate
            }
            const idx = existingTemplates.indexOf(beforeName);
            if (idx !== -1) {
              taskEntry.templates.splice(idx, 0, templateRef);
            } else {
              this.addTemplateToTask(templateRef, taskEntry, taskName, opts);
            }
            continue; // Template added, skip to next entry
          }
        }
        // Handle after: support both string and array
        const afterValue = templateRef.after;
        if (afterValue) {
          const afterName =
            Array.isArray(afterValue) && afterValue.length > 0
              ? afterValue[0]
              : typeof afterValue === "string"
                ? afterValue
                : null;

          if (afterName) {
            const existingTemplates = taskEntry.templates.map((t) =>
              typeof t === "string" ? t : (t as ITemplateReference).name,
            );
            // Check for duplicates before inserting
            if (existingTemplates.includes(name)) {
              const error = new JsonError(
                `Template '${name}' appears multiple times in ${taskName} task. Each template can only appear once per task.`,
              );
              this.addErrorToOptions(opts, error);
              return; // Don't add duplicate
            }
            const idx = existingTemplates.indexOf(afterName);
            if (idx !== -1) {
              taskEntry.templates.splice(idx + 1, 0, templateRef);
            } else {
              this.addTemplateToTask(templateRef, taskEntry, taskName, opts);
            }
            continue; // Template added, skip to next entry
          }
        }
        // No before/after specified, add at end
        this.addTemplateToTask(templateRef, taskEntry, taskName, opts);
      }
    }
  }

  /**
   * Adds a template to the task entry. Duplicates are not allowed and will cause an error.
   * Templates are inserted at the correct position based on their category order.
   */
  private addTemplateToTask(
    template: ITemplateReference | string,
    taskEntry: { task: string; templates: (ITemplateReference | string)[] },
    taskName: string,
    opts: IReadApplicationOptions,
  ): void {
    // Check for duplicates - duplicates are not allowed
    const templateNameStr =
      typeof template === "string" ? template : template.name;
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

    // Get category of the new template
    const newCategory =
      typeof template === "string" ? undefined : template.category;

    // Insert at correct position based on category order
    const insertIndex = this.findCategoryInsertIndex(
      taskEntry.templates,
      newCategory,
    );
    taskEntry.templates.splice(insertIndex, 0, template);
  }

  /**
   * Category order for installation tasks.
   * Templates are grouped by category in this order.
   */
  private static readonly CATEGORY_ORDER = [
    "image",
    "pre_start",
    "start",
    "post_start",
  ];

  /**
   * Finds the correct insert index for a template based on its category.
   * Templates of the same category are appended at the end of that category group.
   * Templates without category go to the end.
   */
  private findCategoryInsertIndex(
    templates: (ITemplateReference | string)[],
    category: string | undefined,
  ): number {
    if (!category) {
      // No category: append at end
      return templates.length;
    }

    const categoryIndex =
      ApplicationPersistenceHandler.CATEGORY_ORDER.indexOf(category);
    if (categoryIndex === -1) {
      // Unknown category: append at end
      return templates.length;
    }

    // Find the first template that belongs to a later category
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i];
      const existingCategory =
        typeof t === "string" ? undefined : (t as ITemplateReference).category;

      if (existingCategory) {
        const existingCategoryIndex =
          ApplicationPersistenceHandler.CATEGORY_ORDER.indexOf(existingCategory);
        if (existingCategoryIndex > categoryIndex) {
          // Found a template from a later category - insert before it
          return i;
        }
      }
    }

    // No later category found, append at end
    return templates.length;
  }
}
