import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export enum Volume {
  LocalRoot = "local_root",
  LocalStorageContext = "local_storagecontext",
  LocalSecrets = "local_secrets",
  LocalRestartInfo = "local_restart_info",
  JsonRoot = "json_root",
  JsonApplications = "json_applications",
  JsonApplicationsTemplates = "json_applications_templates",
  JsonApplicationsIcons = "json_applications_icons",
  JsonShared = "json_shared",
  JsonSharedScripts = "json_shared_scripts",
  JsonSharedTemplates = "json_shared_templates",
  JsonFrameworks = "json_frameworks",
  JsonAddons = "json_addons",
  Schemas = "schemas",
  Scripts = "scripts",
  DocsRoot = "docs_root",
}

export interface TestPersistenceOptions {
  repoRoot?: string;
  localRoot?: string;
  jsonRoot?: string;
  schemasRoot?: string;
  scriptsRoot?: string;
  docsRoot?: string;
}

export class TestPersistenceHelper {
  private readonly repoRoot: string;
  private readonly localRoot: string;
  private readonly jsonRoot: string;
  private readonly schemasRoot: string;
  private readonly scriptsRoot: string;
  private readonly docsRoot: string;

  constructor(options: TestPersistenceOptions = {}) {
    this.repoRoot = options.repoRoot ?? TestPersistenceHelper.getRepoRoot();
    this.localRoot = options.localRoot ?? path.join(this.repoRoot, "local");
    this.jsonRoot = options.jsonRoot ?? path.join(this.repoRoot, "json");
    this.schemasRoot =
      options.schemasRoot ?? path.join(this.repoRoot, "schemas");
    this.scriptsRoot =
      options.scriptsRoot ?? path.join(this.repoRoot, "scripts");
    this.docsRoot = options.docsRoot ?? path.join(this.repoRoot, "docs");
  }

  static getRepoRoot(): string {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    return path.resolve(__dirname, "..", "..", "..");
  }

  resolve(volume: Volume, key = ""): string {
    switch (volume) {
      case Volume.LocalStorageContext:
        return path.join(this.localRoot, "storagecontext.json");
      case Volume.LocalSecrets:
        return path.join(this.localRoot, "secret.txt");
      case Volume.LocalRestartInfo:
        return path.join(this.localRoot, "restart-info.json");
      default: {
        const base = this.getBaseDir(volume);
        const target = key ? path.join(base, key) : base;
        return this.ensureWithin(base, target);
      }
    }
  }

  getBaseDir(volume: Volume): string {
    switch (volume) {
      case Volume.LocalRoot:
        return this.localRoot;
      case Volume.JsonRoot:
        return this.jsonRoot;
      case Volume.JsonApplications:
      case Volume.JsonApplicationsTemplates:
      case Volume.JsonApplicationsIcons:
        return path.join(this.jsonRoot, "applications");
      case Volume.JsonShared:
        return path.join(this.jsonRoot, "shared");
      case Volume.JsonSharedScripts:
        return path.join(this.jsonRoot, "shared", "scripts");
      case Volume.JsonSharedTemplates:
        return path.join(this.jsonRoot, "shared", "templates");
      case Volume.JsonFrameworks:
        return path.join(this.jsonRoot, "frameworks");
      case Volume.JsonAddons:
        return path.join(this.jsonRoot, "addons");
      case Volume.Schemas:
        return this.schemasRoot;
      case Volume.Scripts:
        return this.scriptsRoot;
      case Volume.DocsRoot:
        return this.docsRoot;
      default:
        return this.localRoot;
    }
  }

  async readText(volume: Volume, key = ""): Promise<string> {
    const target = this.resolve(volume, key);
    return fs.readFile(target, "utf-8");
  }

  readTextSync(volume: Volume, key = ""): string {
    const target = this.resolve(volume, key);
    return fsSync.readFileSync(target, "utf-8");
  }

  async writeText(volume: Volume, key: string, content: string): Promise<void> {
    const target = this.resolve(volume, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf-8");
  }

  writeTextSync(volume: Volume, key: string, content: string): void {
    const target = this.resolve(volume, key);
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    fsSync.writeFileSync(target, content, "utf-8");
  }

  async readJson<T = unknown>(volume: Volume, key = ""): Promise<T> {
    const text = await this.readText(volume, key);
    return JSON.parse(text) as T;
  }

  readJsonSync<T = unknown>(volume: Volume, key = ""): T {
    const text = this.readTextSync(volume, key);
    return JSON.parse(text) as T;
  }

  async writeJson(volume: Volume, key: string, data: unknown): Promise<void> {
    const content = JSON.stringify(data, null, 2);
    await this.writeText(volume, key, content);
  }

  writeJsonSync(volume: Volume, key: string, data: unknown): void {
    const content = JSON.stringify(data, null, 2);
    this.writeTextSync(volume, key, content);
  }

  async readBinary(volume: Volume, key = ""): Promise<Buffer> {
    const target = this.resolve(volume, key);
    return fs.readFile(target);
  }

  readBinarySync(volume: Volume, key = ""): Buffer {
    const target = this.resolve(volume, key);
    return fsSync.readFileSync(target);
  }

  async writeBinary(volume: Volume, key: string, data: Buffer): Promise<void> {
    const target = this.resolve(volume, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
  }

  writeBinarySync(volume: Volume, key: string, data: Buffer): void {
    const target = this.resolve(volume, key);
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    fsSync.writeFileSync(target, data);
  }

  ensureDirSync(volume: Volume, key: string): void {
    const target = this.resolve(volume, key);
    fsSync.mkdirSync(target, { recursive: true });
  }

  existsSync(volume: Volume, key: string): boolean {
    const target = this.resolve(volume, key);
    return fsSync.existsSync(target);
  }

  removeSync(volume: Volume, key: string): void {
    const target = this.resolve(volume, key);
    fsSync.rmSync(target, { recursive: true, force: true });
  }

  async list(volume: Volume, prefix = ""): Promise<string[]> {
    const base = this.resolve(volume, prefix);
    try {
      const stat = await fs.stat(base);
      if (!stat.isDirectory()) {
        return [path.basename(base)];
      }
    } catch {
      return [];
    }

    const results: string[] = [];
    await this.walkDir(base, base, results);
    return results;
  }

  listSync(volume: Volume, prefix = ""): string[] {
    const base = this.resolve(volume, prefix);
    try {
      const stat = fsSync.statSync(base);
      if (!stat.isDirectory()) {
        return [path.basename(base)];
      }
    } catch {
      return [];
    }

    const results: string[] = [];
    const walk = (dir: string, baseDir: string) => {
      const entries = fsSync.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full, baseDir);
        } else {
          results.push(path.relative(baseDir, full));
        }
      }
    };

    walk(base, base);
    return results;
  }

  private async walkDir(
    dir: string,
    base: string,
    out: string[],
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDir(full, base, out);
      } else {
        out.push(path.relative(base, full));
      }
    }
  }

  private ensureWithin(baseDir: string, target: string): string {
    const base = path.resolve(baseDir);
    const resolved = path.resolve(target);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) {
      throw new Error(`Path escapes volume: ${target}`);
    }
    return resolved;
  }
}
