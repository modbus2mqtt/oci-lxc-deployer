import path, { dirname, join } from "path";
import { fileURLToPath } from "url";
import { JsonValidator } from "./jsonvalidator.mjs";
import { readdirSync, statSync, existsSync } from "fs";
import {
  IConfiguredPathes,
  IContext,
  IReadApplicationOptions,
  IVEContext,
  IVMContext,
  IVMInstallContext,
  VEConfigurationError,
  storageKey as storageContextKey,
} from "./backend-types.mjs";
import { TemplateProcessor } from "./templateprocessor.mjs";
import { IApplicationWeb, ISsh, TaskType } from "./types.mjs";
import { Context } from "./context.mjs";
import { Ssh } from "./ssh.mjs";
import { ApplicationLoader } from "./apploader.mjs";

const baseSchemas: string[] = ["templatelist.schema.json"];

export class VMContext implements IVMContext {
  constructor(data: IVMContext) {
    this.vmid = data.vmid;
    this.vekey = data.vekey;
    this.data = data.data;
  }
  public vmid: number;
  public vekey: string;
  public data: any;
  getKey(): string {
    return `vm_${this.vmid}`;
  }
}

export class VMInstallContext implements IVMInstallContext {
  constructor(data: IVMInstallContext) {
    this.hostname = data.hostname;
    this.application = data.application;
    this.task = data.task;
    this.changedParams = data.changedParams;
  }
  public hostname: string;
  public application: string;
  public task: TaskType;
  public changedParams: Array<{ name: string; value: string | number | boolean }>;
  getKey(): string {
    return `vminstall_${this.hostname}_${this.application}`;
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
  getKey(): string {
    return `ve_${this.host}`;
  }
}
export class StorageContext extends Context implements IContext {
  static instance: StorageContext | undefined;
  static setInstance(
    localPath: string,
    storageContextFilePath: string,
    secretFilePath: string,
  ): StorageContext {
    StorageContext.instance = new StorageContext(
      localPath,
      storageContextFilePath,
      secretFilePath,
    );
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
  private jsonPath: string;
  private schemaPath: string;
  private pathes: IConfiguredPathes;
  constructor(
    localPath: string,
    storageContextFilePath: string,
    secretFilePath: string,
  ) {
    super(storageContextFilePath, secretFilePath);
    const rootDirname = join(dirname(fileURLToPath(import.meta.url)), "../..");
    this.pathes = {
      localPath: localPath,
      jsonPath: path.join(rootDirname, "json"),
      schemaPath: path.join(rootDirname, "schemas"),
    };
    this.jsonPath = path.join(rootDirname, "json");
    this.schemaPath = path.join(rootDirname, "schemas");
    this.jsonValidator = new JsonValidator(this.schemaPath, baseSchemas);
    this.loadContexts("vm", VMContext);
    this.loadContexts("ve", VEContext);
    this.loadContexts("vminstall", VMInstallContext);
  }
  getLocalPath(): string {
    return this.pathes.localPath;
  }
  getJsonPath(): string {
    return this.pathes.jsonPath;
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
    [this.pathes.localPath, this.pathes.jsonPath].forEach((jPath) => {
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
    return new TemplateProcessor(this.pathes, this);
  }
  listApplications(): IApplicationWeb[] {
    const applications: IApplicationWeb[] = [];
    for (const [applicationName] of this.getAllAppNames()) {
      const readOpts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", applicationName),
        taskTemplates: [],
      };
      const appLoader = new ApplicationLoader(this.pathes);
      try {
        let app = appLoader.readApplicationJson(applicationName, readOpts);
        app.description = app.description || "No desription available";
        applications.push(app as IApplicationWeb);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e: Error | any) {
         // Errors are handled below
      }
      if (readOpts.error.details && readOpts.error.details.length > 0 && applications.length > 0) {
        applications[applications.length - 1]!.errors = readOpts.error.details;
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
  setVMContext(vmContext: IVMContext): string {
    const key = `vm_${vmContext.vmid}`;
    this.set(key, new VMContext(vmContext));
    return key;
  }
  setVEContext(veContext: IVEContext): string {
    const key = `ve_${veContext.host}`;
    this.set(key, new VEContext(veContext));
    return key;
  }
  setVMInstallContext(vmInstallContext: IVMInstallContext): string {
    const vmInstall = new VMInstallContext(vmInstallContext);
    const key = vmInstall.getKey();
    this.set(key, vmInstall);
    return key;
  }

  getVEContextByKey(key: string): IVEContext | null {
    const value = this.get(key);
    if (value instanceof VEContext) return value as IVEContext;
    return null;
  }

  /** Find a VMContext by hostname stored inside its data */
  getVMContextByHostname(hostname: string): IVMContext | null {
    for (const key of this.keys().filter((k) => k.startsWith("vm_"))) {
      const value = this.get(key);
      if (value instanceof VMContext) {
        const vm = value as VMContext;
        const h = (vm as any)?.data?.hostname;
        if (typeof h === "string" && h === hostname) {
          return vm as IVMContext;
        }
      }
    }
    return null;
  }

  /** Find a VMInstallContext by hostname and application */
  getVMInstallContextByHostnameAndApplication(
    hostname: string,
    application: string,
  ): IVMInstallContext | null {
    const key = `vminstall_${hostname}_${application}`;
    const value = this.get(key);
    if (value instanceof VMInstallContext) {
      return value as IVMInstallContext;
    }
    return null;
  }

  /** Build ISsh descriptors for all VE contexts using current storage */
  listSshConfigs(): ISsh[] {
    const result: ISsh[] = [];
    const pubCmd = Ssh.getPublicKeyCommand();
    const install = Ssh.getInstallSshServerCommand();
    for (const key of this.keys().filter((k) => k.startsWith("ve_"))) {
      const anyCtx: any = this.get(key);
      if (anyCtx && typeof anyCtx.host === "string") {
        const item: ISsh = { host: anyCtx.host } as ISsh;
        if (typeof anyCtx.port === "number") item.port = anyCtx.port;
        if (typeof anyCtx.current === "boolean") item.current = anyCtx.current;
        if (pubCmd) item.publicKeyCommand = pubCmd;
        item.installSshServer = install;
        const perm = Ssh.checkSshPermission(item.host, item.port);
        item.permissionOk = perm.permissionOk;
        if (perm.stderr) (item as any).stderr = perm.stderr;
        result.push(item);
      }
    }
    return result;
  }

  /** Build an ISsh descriptor from the current VE context in StorageContext */
  getCurrentSsh(): ISsh | null {
    const ctx = this.getCurrentVEContext();
    if (!ctx) return null;
    const pub = Ssh.getPublicKeyCommand();
    const install = Ssh.getInstallSshServerCommand();
    const base: ISsh = { host: ctx.host } as ISsh;
    if (typeof ctx.port === "number") base.port = ctx.port;
    if (typeof ctx.current === "boolean") base.current = ctx.current;
    if (pub) base.publicKeyCommand = pub;
    base.installSshServer = install;
    const perm = Ssh.checkSshPermission(base.host, base.port);
    base.permissionOk = perm.permissionOk;
    if ((perm as any).stderr) (base as any).stderr = (perm as any).stderr;
    return base;
  }
}
