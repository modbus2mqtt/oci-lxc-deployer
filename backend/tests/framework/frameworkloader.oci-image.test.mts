import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { VEConfigurationError, IVEContext } from "@src/backend-types.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";

describe("FrameworkLoader - oci-image", () => {
  let env: TestEnvironment;
  let loader: FrameworkLoader;
  let contextManager: ReturnType<TestEnvironment["initPersistence"]>["ctx"];
  let pm: ReturnType<TestEnvironment["initPersistence"]>["pm"];

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [
        "^frameworks/oci-image\\.json$",
        "^applications/oci-image/.*",
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
    "should mark volumes parameter as optional (not required) for oci-image framework",
    async () => {
      const veContext: IVEContext = {
        host: "validation-dummy",
        getStorageContext: () => contextManager as any,
        getKey: () => "ve_validation",
      };

      const parameters = await loader.getParameters(
        "oci-image",
        "installation",
        veContext,
      );

      // Find the volumes parameter
      const volumesParam = parameters.find(p => p.id === "volumes");

      expect(volumesParam).toBeDefined();

      // volumes should be optional in create-application workflow
      // because the user may not need volumes for simple OCI containers
      expect(volumesParam?.required).toBe(false);
    },
    60000, // 60 second timeout
  );

  it(
    "should mark required parameters (like oci_image) as required",
    async () => {
      const veContext: IVEContext = {
        host: "validation-dummy",
        getStorageContext: () => contextManager as any,
        getKey: () => "ve_validation",
      };

      const parameters = await loader.getParameters(
        "oci-image",
        "installation",
        veContext,
      );

      // oci_image should be required - it's essential for the framework
      const ociImageParam = parameters.find(p => p.id === "oci_image");
      expect(ociImageParam).toBeDefined();
      expect(ociImageParam?.required).toBe(true);
    },
    60000,
  );
});
