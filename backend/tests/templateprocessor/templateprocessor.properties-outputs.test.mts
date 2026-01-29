import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templates/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

describe("TemplateProcessor properties outputs generation", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let contextManager: ReturnType<typeof PersistenceManager.getInstance>["getContextManager"];
  let tp: TemplateProcessor;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });

    const templatesDir = persistenceHelper.resolve(Volume.JsonApplications, "test-app/templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    const applicationJson = {
      "name": "Test Application",
      "description": "Test application for properties outputs",
      "installation": ["set-parameters.json"]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-app/application.json", applicationJson);

    // Create set-parameters.json template (based on the real one)
    const setParametersTemplate = {
      "execute_on": "ve",
      "name": "Set Parameters",
      "description": "Set application-specific parameters",
      "parameters": [
        {
          "id": "hostname",
          "name": "Hostname",
          "type": "string",
          "default": "test",
          "required": true,
          "description": "Hostname for the container"
        },
        {
          "id": "uid",
          "name": "UID",
          "type": "string",
          "default": "1000",
          "description": "UID for permissions",
          "advanced": true
        },
        {
          "id": "gid",
          "name": "GID",
          "type": "string",
          "default": "1000",
          "description": "GID for permissions",
          "advanced": true
        }
      ],
      "commands": [
        {
          "properties": [
            {
              "id": "ostype",
              "value": "debian"
            },
            {
              "id": "oci_image",
              "value": "test/image"
            },
            {
              "id": "uid",
              "value": "{{uid}}"
            },
            {
              "id": "gid",
              "value": "{{gid}}"
            },
            {
              "id": "volumes",
              "value": "data=test"
            },
            {
              "id": "envs",
              "value": "USERNAME={{hostname}}\nPASSWORD=secret"
            }
          ]
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-app/templates/set-parameters.json", setParametersTemplate);

    const { ctx } = env.initPersistence();
    contextManager = ctx;
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    env?.cleanup();
  });

  it("should automatically generate outputs from properties commands", async () => {
    let loaded;
    try {
      loaded = await tp.loadApplication(
        "test-app",
        "installation",
        veContext,
        ExecutionMode.TEST,
      );
    } catch (err: any) {
      console.error("Error loading application:", err);
      if (err.details) {
        console.error("Error details:", JSON.stringify(err.details, null, 2));
      }
      throw err;
    }

    // Check that all property IDs are in resolvedParams (which means they were treated as outputs)
    const resolvedParamIds = loaded.resolvedParams.map((p) => p.id);
    
    // All IDs from properties should be in resolvedParams
    expect(resolvedParamIds).toContain("ostype");
    expect(resolvedParamIds).toContain("oci_image");
    expect(resolvedParamIds).toContain("uid");
    expect(resolvedParamIds).toContain("gid");
    expect(resolvedParamIds).toContain("volumes");
    expect(resolvedParamIds).toContain("envs");

    // Verify they were marked as resolved from the set-parameters template
    const ostypeParam = loaded.resolvedParams.find((p) => p.id === "ostype");
    expect(ostypeParam).toBeDefined();
    expect(ostypeParam?.template).toBe("set-parameters.json");

    const ociImageParam = loaded.resolvedParams.find((p) => p.id === "oci_image");
    expect(ociImageParam).toBeDefined();
    expect(ociImageParam?.template).toBe("set-parameters.json");

    const volumesParam = loaded.resolvedParams.find((p) => p.id === "volumes");
    expect(volumesParam).toBeDefined();
    expect(volumesParam?.template).toBe("set-parameters.json");

    const envsParam = loaded.resolvedParams.find((p) => p.id === "envs");
    expect(envsParam).toBeDefined();
    expect(envsParam?.template).toBe("set-parameters.json");
  });

  it("should handle properties with variable substitution in values", async () => {
    const loaded = await tp.loadApplication(
      "test-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // uid and gid should be in resolvedParams even though they reference variables
    const resolvedParamIds = loaded.resolvedParams.map((p) => p.id);
    expect(resolvedParamIds).toContain("uid");
    expect(resolvedParamIds).toContain("gid");

    // These should be marked as resolved from set-parameters
    const uidParam = loaded.resolvedParams.find((p) => p.id === "uid");
    expect(uidParam).toBeDefined();
    expect(uidParam?.template).toBe("set-parameters.json");

    const gidParam = loaded.resolvedParams.find((p) => p.id === "gid");
    expect(gidParam).toBeDefined();
    expect(gidParam?.template).toBe("set-parameters.json");
  });
});

