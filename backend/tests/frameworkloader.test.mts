import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { StorageContext } from "@src/storagecontext.mjs";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { VEConfigurationError, IVEContext } from "@src/backend-types.mjs";

describe("FrameworkLoader", () => {
  let tempDir: string;
  let loader: FrameworkLoader;
  let storage: StorageContext;

  beforeAll(() => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, "..", "..");
    tempDir = mkdtempSync(path.join(os.tmpdir(), "lxc-fw-"));
    const storageContextFile = path.join(tempDir, "storagecontext.json");
    const secretFile = path.join(tempDir, "secret.txt");

    StorageContext.setInstance(
      path.join(repoRoot, "local"),
      storageContextFile,
      secretFile,
    );
    storage = StorageContext.getInstance();
    loader = new FrameworkLoader(
      {
        localPath: path.join(repoRoot, "local"),
        jsonPath: path.join(repoRoot, "json"),
        schemaPath: path.join(repoRoot, "schemas"),
      },
      storage,
    );
  });

  afterAll(() => {
    // Cleanup
    try {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (e: any) {
      // Ignore cleanup errors
    }
  });

  it(
    "should load framework and get parameters",
    async () => {
      const framework = loader.readFrameworkJson("npm-nodejs", {
        error: new VEConfigurationError("", "npm-nodejs"),
      });
      const veContext: IVEContext = {
        host: "validation-dummy",
        getStorageContext: () => storage,
        getKey: () => "ve_validation",
      };

      // getParameters can be slow due to:
      // - Template processing (loadApplication)
      // - Script validation (may attempt SSH connections with retries)
      // - File system operations
      const parameters = await loader.getParameters(
        "npm-nodejs",
        "installation",
        veContext,
      );
      expect(parameters.length).toBe(framework.properties.length);
      for (const param of parameters) {
        expect(param.required).toBe(true);
        expect((param as any).advanced).toBeUndefined();
      }
    },
    60000, // 60 second timeout - getParameters can be slow due to template processing and SSH retries
  );
});

