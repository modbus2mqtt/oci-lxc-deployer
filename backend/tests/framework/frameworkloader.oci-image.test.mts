import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { IPostFrameworkCreateApplicationBody } from "@src/types.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import * as path from "path";
import * as fs from "fs";

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

  it("should mark volumes parameter as optional (not required) for oci-image framework", async () => {
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
    const volumesParam = parameters.find((p) => p.id === "volumes");

    expect(volumesParam).toBeDefined();

    // volumes should be optional in create-application workflow
    // because the user may not need volumes for simple OCI containers
    expect(volumesParam?.required).toBe(false);
  }, 60000); // 60 second timeout

  it("should mark required parameters (like oci_image) as required", async () => {
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
    const ociImageParam = parameters.find((p) => p.id === "oci_image");
    expect(ociImageParam).toBeDefined();
    expect(ociImageParam?.required).toBe(true);
  }, 60000);

  it("should NOT store compose_file in application.json for oci-image framework", async () => {
    // compose_file is only relevant for docker-compose framework
    // For oci-image, even if passed, it should NOT be stored in application.json
    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "oci-image",
      applicationId: "test-oci-no-compose",
      name: "Test OCI No Compose",
      description: "Test that compose_file is not stored for oci-image",
      parameterValues: [
        { id: "oci_image", value: "alpine:latest" },
        { id: "hostname", value: "test-oci" },
        // Intentionally pass compose_file - it should be ignored
        {
          id: "compose_file",
          value: "c2VydmljZXM6CiAgdGVzdDoKICAgIGltYWdlOiBhbHBpbmU=",
        },
      ],
    };

    const applicationId = await loader.createApplicationFromFramework(request);
    expect(applicationId).toBe("test-oci-no-compose");

    // Read generated application.json
    const appJsonPath = path.join(
      env.localDir,
      "applications",
      "test-oci-no-compose",
      "application.json",
    );
    const appJson = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));

    // compose_file should NOT be in properties for oci-image framework
    const composeFileProperty = appJson.properties?.find(
      (p: any) => p.id === "compose_file",
    );
    expect(composeFileProperty).toBeUndefined();

    // compose_file should NOT be in parameters with default value
    const composeFileParam = appJson.parameters?.find(
      (p: any) => p.id === "compose_file",
    );
    if (composeFileParam) {
      expect(composeFileParam.default).toBeUndefined();
    }
  }, 60000);
});
