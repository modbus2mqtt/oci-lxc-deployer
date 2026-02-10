import path from "path";
import fs from "fs";
import { IConfiguredPathes, VEConfigurationError } from "../backend-types.mjs";
import { IFramework } from "../types.mjs";
import { JsonValidator } from "../jsonvalidator.mjs";

/**
 * Handles framework-specific persistence operations
 * Separated from main FileSystemPersistence for better organization
 */
export class FrameworkPersistenceHandler {
  // Framework Caches
  private frameworkNamesCache: {
    json: Map<string, string> | null;
    local: Map<string, string> | null;
  } = {
    json: null,
    local: null,
  };
  private frameworkCache: Map<string, { data: IFramework; mtime: number }> =
    new Map();

  constructor(
    private pathes: IConfiguredPathes,
    private jsonValidator: JsonValidator,
    private enableCache: boolean = true,
  ) {}

  getAllFrameworkNames(): Map<string, string> {
    if (!this.enableCache) {
      // Cache disabled: always scan fresh
      const jsonFrameworks = this.scanFrameworksDir(this.pathes.jsonPath);
      const localFrameworks = this.scanFrameworksDir(this.pathes.localPath);
      const result = new Map(jsonFrameworks);
      for (const [name, frameworkPath] of localFrameworks) {
        result.set(name, frameworkPath);
      }
      return result;
    }

    // JSON: Einmalig laden
    if (this.frameworkNamesCache.json === null) {
      this.frameworkNamesCache.json = this.scanFrameworksDir(
        this.pathes.jsonPath,
      );
    }

    // Local: Aus Cache (wird durch fs.watch invalidiert)
    if (this.frameworkNamesCache.local === null) {
      this.frameworkNamesCache.local = this.scanFrameworksDir(
        this.pathes.localPath,
      );
    }

    // Merge: Local hat Priorität
    const result = new Map(this.frameworkNamesCache.json);
    for (const [name, frameworkPath] of this.frameworkNamesCache.local) {
      result.set(name, frameworkPath);
    }
    return result;
  }

  readFramework(
    frameworkId: string,
    opts: {
      framework?: IFramework;
      frameworkPath?: string;
      error: VEConfigurationError;
    },
  ): IFramework {
    let frameworkPath: string | undefined;
    let frameworkFile: string | undefined;
    let frameworkName = frameworkId;

    // Handle json: prefix
    if (frameworkId.startsWith("json:")) {
      frameworkName = frameworkId.replace(/^json:/, "");
      frameworkPath = path.join(this.pathes.jsonPath, "frameworks");
      frameworkFile = path.join(frameworkPath, `${frameworkName}.json`);
      if (!fs.existsSync(frameworkFile)) {
        throw new Error(`framework json not found for ${frameworkId}`);
      }
    } else {
      // First check local, then json
      const localFile = path.join(
        this.pathes.localPath,
        "frameworks",
        `${frameworkId}.json`,
      );
      const jsonFile = path.join(
        this.pathes.jsonPath,
        "frameworks",
        `${frameworkId}.json`,
      );
      if (fs.existsSync(localFile)) {
        frameworkFile = localFile;
        frameworkPath = path.dirname(localFile);
      } else if (fs.existsSync(jsonFile)) {
        frameworkFile = jsonFile;
        frameworkPath = path.dirname(jsonFile);
      } else {
        throw new Error(`framework json not found for ${frameworkId}`);
      }
    }

    // Check cache first (only for local frameworks)
    const isLocal = frameworkPath.startsWith(this.pathes.localPath);
    if (isLocal) {
      const mtime = fs.statSync(frameworkFile).mtimeMs;
      const cached = this.frameworkCache.get(frameworkId);
      if (cached && cached.mtime === mtime) {
        opts.framework = cached.data;
        opts.frameworkPath = frameworkPath;
        return cached.data;
      }
    }

    // Load and validate
    let frameworkData: IFramework;
    try {
      frameworkData =
        this.jsonValidator.serializeJsonFileWithSchema<IFramework>(
          frameworkFile,
          "framework",
        );
    } catch (e: Error | any) {
      this.addErrorToOptions(opts, e);
      throw opts.error;
    }

    frameworkData.id = frameworkName;
    opts.framework = frameworkData;
    opts.frameworkPath = frameworkPath;

    // Cache only local frameworks
    if (isLocal) {
      const mtime = fs.statSync(frameworkFile).mtimeMs;
      this.frameworkCache.set(frameworkId, { data: frameworkData, mtime });
    }

    return frameworkData;
  }

  writeFramework(frameworkId: string, framework: IFramework): void {
    const frameworkDir = path.join(this.pathes.localPath, "frameworks");
    fs.mkdirSync(frameworkDir, { recursive: true });

    const frameworkFile = path.join(frameworkDir, `${frameworkId}.json`);
    fs.writeFileSync(frameworkFile, JSON.stringify(framework, null, 2));

    // Invalidate caches
    this.invalidateFrameworkCache(frameworkId);
  }

  deleteFramework(frameworkId: string): void {
    const frameworkFile = path.join(
      this.pathes.localPath,
      "frameworks",
      `${frameworkId}.json`,
    );
    if (fs.existsSync(frameworkFile)) {
      fs.unlinkSync(frameworkFile);
    }

    // Invalidate caches
    this.invalidateFrameworkCache(frameworkId);
  }

  invalidateFrameworkCache(frameworkId?: string): void {
    this.frameworkNamesCache.local = null;
    if (frameworkId) {
      this.frameworkCache.delete(frameworkId);
    } else {
      this.frameworkCache.clear();
    }
  }

  invalidateAllCaches(): void {
    this.frameworkNamesCache.json = null;
    this.frameworkNamesCache.local = null;
    this.frameworkCache.clear();
  }

  // Helper methods

  private scanFrameworksDir(basePath: string): Map<string, string> {
    const frameworks = new Map<string, string>();
    const frameworksDir = path.join(basePath, "frameworks");

    if (!fs.existsSync(frameworksDir)) return frameworks;

    const entries = fs.readdirSync(frameworksDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        const frameworkId = entry.name.replace(/\.json$/, "");
        frameworks.set(frameworkId, path.join(frameworksDir, entry.name));
      }
    }

    return frameworks;
  }

  private addErrorToOptions(
    opts: { error: VEConfigurationError },
    error: Error | any,
  ): void {
    if (opts.error && Array.isArray(opts.error.details)) {
      opts.error.details.push(error);
    } else if (opts.error) {
      opts.error.details = [error];
    }
  }
}
