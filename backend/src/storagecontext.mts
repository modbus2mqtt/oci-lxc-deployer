import path, { join } from "path";
import { JsonError, JsonValidator } from "./jsonvalidator.mjs";
import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import {
  IConfiguredPathes,
  IContext,
  IVEContext,
  IVMContext,
  VEConfigurationError,
  storageKey as storageContextKey,
} from "./backend-types.mjs";
import { TemplateProcessor } from "./templateprocessor.mjs";
import { IApplicationWeb } from "./types.mjs";
import { Context } from "./context.mjs";

const baseSchemas: string[] = ["templatelist.schema.json"];

class VMContext implements IVMContext {
  vmid: number;
  vekey: string;
  constructor(data: IVMContext) {
    this.vmid = data.vmid;
    this.vekey = data.vekey;
  }
}

class VEContext implements IVEContext {
  host: string;
  port?: number;
  current?: boolean;
  constructor(data: IVEContext) {
    this.host = data.host;
    if (data.port !== undefined) this.port = data.port;
    if (data.current !== undefined) this.current = data.current;
  }
  getStorageContext(): StorageContext {
    return StorageContext.getInstance();
  }
}
export class StorageContext extends Context implements IContext {
  static instance: StorageContext | undefined;
  static setInstance(localPath: string): StorageContext {
    StorageContext.instance = new StorageContext(localPath);
    return StorageContext.instance;
  }
  static getInstance(): StorageContext {
    if (!StorageContext.instance) {
      throw new VEConfigurationError(
        "StorageContext instance not set",
        storageContextKey,
      );
    }
    return StorageContext.instance;
  }
  jsonValidator: JsonValidator;
  constructor(
    private localPath: string,
    private jsonPath: string = "json",
    private schemaPath: string = "schemas",
  ) {
    super(join(localPath, "storagecontext.json"));
    this.jsonValidator = new JsonValidator(this.schemaPath, baseSchemas);
    this.loadContexts("vm", VMContext);
    this.loadContexts("ve", VEContext);
  }
  getKey(): string {
    // return `storage_${this.localPath.replace(/[\/\\:]/g, "_")}`;
    return storageContextKey;
  }
  getJsonValidator(): JsonValidator {
    return this.jsonValidator;
  }
  getAllAppNames(): Map<string, string> {
    const allApps = new Map<string, string>();
    [this.localPath, this.jsonPath].forEach((jPath) => {
      const appsDir = path.join(jPath, "applications");
      if (existsSync(appsDir))
        readdirSync(appsDir)
          .filter(
            (f) =>
              existsSync(path.join(appsDir, f)) &&
              statSync(path.join(appsDir, f)).isDirectory() &&
              existsSync(path.join(appsDir, f, "application.json")),
          )
          .forEach((f) => {
            if (!allApps.has(f)) allApps.set(f, path.join(appsDir, f));
          });
    });
    return allApps;
  }
  getTemplateProcessor(): TemplateProcessor {
    let pathes: IConfiguredPathes = {
      localPath: this.localPath,
      jsonPath: this.jsonPath,
      schemaPath: this.schemaPath,
    };
    return new TemplateProcessor(pathes);
  }
  listApplications(): IApplicationWeb[] {
    const applications: IApplicationWeb[] = [];
    for (const [appName, appDir] of this.getAllAppNames()) {
      try {
        const appData = JSON.parse(
          readFileSync(path.join(appDir, "application.json"), "utf-8"),
        );
        let iconBase64: string | undefined = undefined;
        const iconPath = path.join(appDir, "icon.png");
        if (existsSync(iconPath)) {
          const iconBuffer = readFileSync(iconPath);
          iconBase64 = iconBuffer.toString("base64");
        }
        try {
          const templateProcessor = this.getTemplateProcessor();
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
          if (err instanceof VEConfigurationError || err instanceof JsonError) {
            if (err.details !== undefined && err.details!.length > 0)
              applications.push({
                name: appData.name,
                description: appData.description,
                icon: appData.icon,
                iconContent: iconBase64,
                id: appName,
                errors: [err.toJSON()],
              });
            else {
              applications.push({
                name: appData.name,
                description: appData.description,
                icon: appData.icon,
                iconContent: iconBase64,
                id: appName,
                errors: [err.toJSON()],
              });
            }
          } else {
            // Error loading application.json or other error
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
        }
      } catch (err) {
        // Error loading application.json
        applications.push({
          name: appName,
          description: "",
          id: appName,
          errors: [(err as any).message || "Unknown error"],
        });
      }
    }
    return applications;
  }
  getCurrentVEContext(): IVEContext | null {
    for (const ctx of this.keys()
      .filter((k) => k.startsWith("ve_"))
      .map((k) => this.get(k))) {
      if (ctx instanceof VEContext && (ctx as IVEContext).current === true) {
        return ctx;
      }
    }
    return null;
  }
  setVMContext(vmContext: IVMContext): void {
    const key = `vm_${vmContext.vmid}`;
    this.set(key, new VMContext(vmContext));
  }
  setVEContext(veContext: IVEContext): void {
    const key = `ve_${veContext.host}`;
    this.set(key, new VEContext(veContext));
  }
}
