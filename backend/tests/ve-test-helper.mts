import fs from "fs-extra";
import path from "path";
import os from "os";
import { StorageContext } from "@src/storagecontext.mjs";
import { TemplateProcessor } from "@src/templateprocessor.mjs";

export interface IApplication {
  name: string;
  description: string;
  installation?: string[];
  backup?: string[];
  restore?: string[];
  uninstall?: string[];
  update?: string[];
  upgrade?: string[];
}

export interface IParameter {
  name: string;
  type: "enum" | "string" | "number" | "boolean";
  enumValues?: string[];
  description?: string;
  default?: string | number | boolean;
  required?: boolean;
  value?: string | number | boolean;
}

export interface ICommand {
  execute_on?: "ve" | "lxc";
  command?: string;
  script?: string;
  template?: string;
  name?: string;
  description?: string;
}

export interface ITemplate {
  execute_on: "ve" | "lxc";
  name: string;
  description?: string;
  parameters?: IParameter[];
  commands: ICommand[];
  outputs?: string[];
}

export class ProxmoxTestHelper {
  tempDir!: string;
  jsonDir!: string;
  schemaDir!: string;
  localDir!: string;

  async setup(): Promise<void> {
    this.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxmox-test-"));
    this.jsonDir = path.join(this.tempDir, "json");
    this.schemaDir = path.join(this.tempDir, "schema");
    this.localDir = path.join(this.tempDir, "local/json");
    await fs.copy(path.join(__dirname, "../json"), this.jsonDir);
    await fs.ensureDir(this.schemaDir);
    await fs.ensureDir(this.localDir);
    // Copy real backend schemas so JsonValidator can resolve references
    const realSchemasDir = path.join(__dirname, "../schemas");
    const entries = await fs.readdir(realSchemasDir);
    for (const entry of entries) {
      const src = path.join(realSchemasDir, entry);
      const dst = path.join(this.schemaDir, entry);
      const stat = await fs.stat(src);
      if (stat.isFile()) await fs.copy(src, dst);
    }
  }

  async cleanup(): Promise<void> {
    if (this.tempDir) {
      await fs.remove(this.tempDir);
    }
  }

  getApplicationNames(): string[] {
    const appsPath = path.join(this.jsonDir, "applications");
    return fs
      .readdirSync(appsPath)
      .filter((f: string) => fs.statSync(path.join(appsPath, f)).isDirectory());
  }

  readApplication(appName: string): IApplication {
    const appPath = path.join(
      this.jsonDir,
      "applications",
      appName,
      "application.json",
    );
    return JSON.parse(fs.readFileSync(appPath, "utf-8")) as IApplication;
  }

  writeApplication(appName: string, data: IApplication): void {
    const appPath = path.join(
      this.jsonDir,
      "applications",
      appName,
      "application.json",
    );
    fs.writeFileSync(appPath, JSON.stringify(data, null, 2), "utf-8");
  }

  getTemplateNames(appName: string): string[] {
    const tmplPath = path.join(
      this.jsonDir,
      "applications",
      appName,
      "templates",
    );
    if (!fs.existsSync(tmplPath)) return [];
    return fs.readdirSync(tmplPath).filter((f: string) => f.endsWith(".json"));
  }

  readTemplate(appName: string, tmplName: string): ITemplate {
    const tmplPath = path.join(
      this.jsonDir,
      "applications",
      appName,
      "templates",
      tmplName,
    );
    return JSON.parse(fs.readFileSync(tmplPath, "utf-8")) as ITemplate;
  }

  writeTemplate(appName: string, tmplName: string, data: ITemplate): void {
    const tmplPath = path.join(
      this.jsonDir,
      "applications",
      appName,
      "templates",
      tmplName,
    );
    fs.writeFileSync(tmplPath, JSON.stringify(data, null, 2), "utf-8");
  }

  writeScript(appName: string, scriptName: string, content: string): void {
    // Write to applications/<appName>/scripts
    const appScriptDir = path.join(
      this.jsonDir,
      "applications",
      appName,
      "scripts",
    );
    fs.ensureDirSync(appScriptDir);
    fs.writeFileSync(path.join(appScriptDir, scriptName), content, "utf-8");
  }

  createStorageContext(): StorageContext {
    const storage = new StorageContext(this.localDir, this.jsonDir, this.schemaDir);
    (StorageContext as any).instance = storage;
    return storage;
  }

  createTemplateProcessor(): TemplateProcessor {
    const storage = this.createStorageContext();
    return storage.getTemplateProcessor();
  }
}
