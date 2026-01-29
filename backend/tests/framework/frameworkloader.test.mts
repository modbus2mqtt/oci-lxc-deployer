import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { VEConfigurationError, IVEContext } from "@src/backend-types.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";

describe("FrameworkLoader", () => {
  let env: TestEnvironment;
  let loader: FrameworkLoader;
  let contextManager: ReturnType<TestEnvironment["initPersistence"]>["ctx"];
  let pm: ReturnType<TestEnvironment["initPersistence"]>["pm"];

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [
        "^frameworks/npm-nodejs\\.json$",
        "^applications/npm-nodejs/.*",
        "^shared/.*",
      ],
    });
    const init = env.initPersistence({ enableCache: false });
    pm = init.pm;
    contextManager = init.ctx;
    loader = new FrameworkLoader(
      {
        localPath: env.localDir,
        jsonPath: env.jsonDir,
        schemaPath: env.schemaDir,
      },
      contextManager,
      pm.getPersistence(),
    );
  });

  afterAll(() => {
    env.cleanup();
  });

  it(
    "should load framework and get parameters",
    async () => {
      const framework = loader.readFrameworkJson("npm-nodejs", {
        error: new VEConfigurationError("", "npm-nodejs"),
      });
      const veContext: IVEContext = {
        host: "validation-dummy",
        getStorageContext: () => contextManager as any,
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

