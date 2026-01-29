import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templates/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

describe("TemplateProcessor - Parameters from skipped templates should not appear in unresolved parameters", () => {
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

    const templatesDir = persistenceHelper.resolve(Volume.JsonApplications, "test-skip-unresolved-app/templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    // Create application.json
    const applicationJson = {
      "name": "Test Skip Unresolved Parameters Application",
      "description": "Test application for skipped template parameters",
      "installation": [
        "set-parameters.json",
        "skipped-template.json"
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-unresolved-app/application.json", applicationJson);

    // Create set-parameters.json template that sets myvariable
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
        }
      ],
      "commands": [
        {
          "properties": [
            {
              "id": "myvariable",
              "value": "test-value"
            }
          ]
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-unresolved-app/templates/set-parameters.json", setParametersTemplate);

    // Create skipped-template.json - will be skipped because myvariable IS set
    // skip_if_property_set skips the template if the variable is set
    const skippedTemplate = {
      "execute_on": "ve",
      "name": "Skipped Template",
      "description": "Template that will be skipped",
      "skip_if_property_set": "myvariable",
      "parameters": [
        {
          "id": "skipped_param1",
          "name": "Skipped Parameter 1",
          "type": "string",
          "required": true,
          "description": "This parameter should NOT appear in unresolved parameters"
        },
        {
          "id": "skipped_param2",
          "name": "Skipped Parameter 2",
          "type": "string",
          "required": false,
          "description": "This parameter should also NOT appear in unresolved parameters"
        }
      ],
      "commands": [
        {
          "name": "Test Command",
          "command": "echo 'test command executed'"
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-unresolved-app/templates/skipped-template.json", skippedTemplate);

    const { ctx } = env.initPersistence({ enableCache: false });
    contextManager = ctx;
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    env?.cleanup();
  });

  it("should NOT include parameters from skipped templates in unresolved parameters", async () => {
    // Load the application
    const loaded = await tp.loadApplication(
      "test-skip-unresolved-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // Verify that skipped-template.json was actually skipped
    // The command name will be "Test Command (skipped)" because cmd.name is used
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("(skipped)") && cmd.command === "exit 0"
    );
    expect(skippedCommand).toBeDefined();

    // Get unresolved parameters
    const unresolved = await tp.getUnresolvedParameters(
      "test-skip-unresolved-app",
      "installation",
      veContext,
    );

    // Parameters from skipped-template.json should NOT appear in unresolved parameters
    const unresolvedIds = unresolved.map((p: any) => p.id);
    expect(unresolvedIds).not.toContain("skipped_param1");
    expect(unresolvedIds).not.toContain("skipped_param2");
    
    // Verify that parameters from skipped templates are not in loaded.parameters either
    const loadedParamIds = loaded.parameters.map((p: any) => p.id);
    expect(loadedParamIds).not.toContain("skipped_param1");
    expect(loadedParamIds).not.toContain("skipped_param2");
  });

  it("should include parameters from skipped templates when skip_if_property_set variable is NOT set", async () => {
    // Create a separate application for this test
    const templatesDir2 = persistenceHelper.resolve(Volume.JsonApplications, "test-skip-unresolved-app-2/templates");
    fs.mkdirSync(templatesDir2, { recursive: true });

    // Create application.json
    const applicationJson2 = {
      "name": "Test Skip Unresolved Parameters Application 2",
      "description": "Test application for skipped template parameters - variable not set",
      "installation": [
        "set-parameters-no-myvariable.json",
        "skip-if-property-set-template.json"
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-unresolved-app-2/application.json", applicationJson2);

    // Create set-parameters.json that does NOT output myvariable
    const setParametersTemplateNoMyVariable = {
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
        }
      ],
      "commands": [
        {
          "properties": [
            {
              "id": "other_param",
              "value": "other-value"
            }
          ]
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-unresolved-app-2/templates/set-parameters-no-myvariable.json", setParametersTemplateNoMyVariable);

    // Create skip-if-property-set-template.json - will NOT be skipped because myvariable is NOT set
    const skipIfPropertySetTemplate = {
      "execute_on": "ve",
      "name": "Skip If Property Set Template",
      "description": "Template that is skipped if myvariable is set",
      "skip_if_property_set": "myvariable",
      "parameters": [
        {
          "id": "not_skipped_param",
          "name": "Not Skipped Parameter",
          "type": "string",
          "required": true,
          "description": "This parameter SHOULD appear in unresolved parameters because template is NOT skipped"
        }
      ],
      "commands": [
        {
          "name": "Test Command",
          "command": "echo 'test command executed'"
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-unresolved-app-2/templates/skip-if-property-set-template.json", skipIfPropertySetTemplate);

    // Get unresolved parameters
    const unresolved = await tp.getUnresolvedParameters(
      "test-skip-unresolved-app-2",
      "installation",
      veContext,
    );

    // Parameters from skip-if-property-set-template.json SHOULD appear because template is NOT skipped
    const unresolvedIds = unresolved.map((p: any) => p.id);
    expect(unresolvedIds).toContain("not_skipped_param");

    // Cleanup handled by env.cleanup()
  });
});

