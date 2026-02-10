import fs from "fs-extra";
import path from "path";
import os from "os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
export class VeTestHelper {
  tempDir;
  jsonDir;
  schemaDir;
  localDir;
  async setup() {
    this.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "proxmox-test-"));
    this.jsonDir = path.join(this.tempDir, "json");
    this.schemaDir = path.join(this.tempDir, "schema");
    this.localDir = path.join(this.tempDir, "local/json");
    const candidates = [
      path.resolve(process.cwd(), ".."),
      path.resolve(process.cwd(), "..", ".."),
      path.resolve(__dirname, "..", "..", ".."),
    ];
    let repoRoot;
    for (const candidate of candidates) {
      if (
        (await fs.pathExists(path.join(candidate, "json"))) &&
        (await fs.pathExists(path.join(candidate, "schemas")))
      ) {
        repoRoot = candidate;
        break;
      }
    }
    if (!repoRoot) {
      throw new Error("Unable to locate repo root for VeTestHelper");
    }
    await fs.copy(path.join(repoRoot, "json"), this.jsonDir);
    await fs.ensureDir(this.schemaDir);
    await fs.ensureDir(this.localDir);
    // Copy real backend schemas so JsonValidator can resolve references
    const realSchemasDir = path.join(repoRoot, "schemas");
    const entries = await fs.readdir(realSchemasDir);
    for (const entry of entries) {
      const src = path.join(realSchemasDir, entry);
      const dst = path.join(this.schemaDir, entry);
      const stat = await fs.stat(src);
      if (stat.isFile()) await fs.copy(src, dst);
    }
  }
  async cleanup() {
    if (this.tempDir) {
      try {
        await fs.remove(this.tempDir);
      } catch {
        // Ignore cleanup errors (e.g., ENOTEMPTY on Windows/macOS)
        // The OS will clean up temp directories eventually
      }
    }
  }
  getApplicationNames() {
    const appsPath = path.join(this.jsonDir, "applications");
    return fs
      .readdirSync(appsPath)
      .filter((f) => fs.statSync(path.join(appsPath, f)).isDirectory());
  }
  readApplication(appName) {
    const appPath = path.join(
      this.jsonDir,
      "applications",
      appName,
      "application.json",
    );
    return JSON.parse(fs.readFileSync(appPath, "utf-8"));
  }
  writeApplication(appName, data) {
    const appDir = path.join(this.jsonDir, "applications", appName);
    fs.ensureDirSync(appDir);
    const appPath = path.join(
      this.jsonDir,
      "applications",
      appName,
      "application.json",
    );
    fs.writeFileSync(appPath, JSON.stringify(data, null, 2), "utf-8");
  }
  getTemplateNames(appName) {
    const tmplPath = path.join(
      this.jsonDir,
      "applications",
      appName,
      "templates",
    );
    if (!fs.existsSync(tmplPath)) return [];
    return fs.readdirSync(tmplPath).filter((f) => f.endsWith(".json"));
  }
  readTemplate(appName, tmplName) {
    const tmplPath = path.join(
      this.jsonDir,
      "applications",
      appName,
      "templates",
      tmplName,
    );
    return JSON.parse(fs.readFileSync(tmplPath, "utf-8"));
  }
  writeTemplate(appName, tmplName, data) {
    const tmplDir = path.join(
      this.jsonDir,
      "applications",
      appName,
      "templates",
    );
    fs.ensureDirSync(tmplDir);
    const tmplPath = path.join(tmplDir, tmplName);
    fs.writeFileSync(tmplPath, JSON.stringify(data, null, 2), "utf-8");
  }
  writeScript(appName, scriptName, content) {
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
  createStorageContext() {
    // Create a valid storagecontext.json file
    const storageContextPath = path.join(this.localDir, "storagecontext.json");
    if (!fs.existsSync(storageContextPath)) {
      fs.writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");
    }
    const secretFilePath = path.join(this.localDir, "secret.txt");
    // Close existing instance if any
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
    PersistenceManager.initialize(
      this.localDir,
      storageContextPath,
      secretFilePath,
      true,
      this.jsonDir,
      this.schemaDir,
    );
    return PersistenceManager.getInstance().getContextManager();
  }
  createTemplateProcessor() {
    const storage = this.createStorageContext();
    return storage.getTemplateProcessor();
  }
}
//# sourceMappingURL=ve-test-helper.mjs.map
