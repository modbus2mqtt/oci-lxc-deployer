import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templates/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

describe("TemplateProcessor skip_if_all_missing", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let contextManager: ReturnType<ReturnType<typeof PersistenceManager.getInstance>["getContextManager"]>;
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

    const templatesDir = persistenceHelper.resolve(Volume.JsonApplications, "test-skip-app/templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    // Create application.json
    const applicationJson = {
      "name": "Test Skip Application",
      "description": "Test application for skip_if_all_missing",
      "installation": [
        "set-parameters.json",
        "optional-template-single.json",
        "optional-template-multiple.json"
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-app/application.json", applicationJson);

    // Create set-parameters.json template that outputs a parameter
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
              "id": "test_param",
              "value": "test-value"
            }
          ]
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-app/templates/set-parameters.json", setParametersTemplate);

    // Create optional-template-single.json - should be skipped if test_param is missing
    const optionalTemplateSingle = {
      "execute_on": "ve",
      "name": "Optional Template Single",
      "description": "Optional template with single parameter",
      "skip_if_all_missing": ["test_param"],
      "parameters": [
        {
          "id": "test_param",
          "name": "Test Parameter",
          "type": "string",
          "required": true,
          "description": "Test parameter"
        }
      ],
      "commands": [
        {
          "name": "Test Command",
          "command": "echo 'test command executed'"
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-app/templates/optional-template-single.json", optionalTemplateSingle);

    // Create optional-template-multiple.json - should be skipped if BOTH param1 and param2 are missing
    const optionalTemplateMultiple = {
      "execute_on": "ve",
      "name": "Optional Template Multiple",
      "description": "Optional template with multiple parameters",
      "skip_if_all_missing": ["param1", "param2"],
      "parameters": [
        {
          "id": "param1",
          "name": "Parameter 1",
          "type": "string",
          "required": false,
          "description": "First parameter"
        },
        {
          "id": "param2",
          "name": "Parameter 2",
          "type": "string",
          "required": false,
          "description": "Second parameter"
        }
      ],
      "commands": [
        {
          "name": "Test Command Multiple",
          "command": "echo 'test command multiple executed'"
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-app/templates/optional-template-multiple.json", optionalTemplateMultiple);

    const { ctx } = env.initPersistence({ enableCache: false });
    contextManager = ctx;
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    env?.cleanup();
  });

  it("should NOT skip template with single parameter when parameter is present", async () => {
    // test_param is provided by set-parameters.json (via properties command),
    // so it should be in resolvedParams when optional-template-single.json is processed.
    // Therefore, the template should NOT be skipped.
    
    const loaded = await tp.loadApplication(
      "test-skip-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // Verify test_param is in resolvedParams (it should be, because set-parameters.json outputs it)
    const resolvedParamIds = loaded.resolvedParams.map((p: any) => p.id);
    expect(resolvedParamIds).toContain("test_param");
    
    // Since test_param is present, the template should NOT be skipped
    // So there should be NO skipped command for "Optional Template Single"
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("Optional Template Single") && cmd.name.includes("(skipped)")
    );
    
    expect(skippedCommand).toBeUndefined();
    
    // There should be a regular command instead
    const regularCommand = loaded.commands.find((cmd: any) => 
      cmd.name === "Test Command" && !cmd.name.includes("(skipped)")
    );
    
    // The command should exist and not be skipped
    expect(regularCommand).toBeDefined();
    expect(regularCommand?.command).toBe("echo 'test command executed'");
  });

  it("should skip template with single parameter when parameter is missing", async () => {
    // Create a separate application for this test to avoid side effects
    const templatesDir2 = persistenceHelper.resolve(Volume.JsonApplications, "test-skip-app-2/templates");
    fs.mkdirSync(templatesDir2, { recursive: true });

    // Create application.json
    const applicationJson2 = {
      "name": "Test Skip Application 2",
      "description": "Test application for skip_if_all_missing - missing param",
      "installation": [
        "set-parameters-no-output.json",
        "optional-template-single.json"
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-app-2/application.json", applicationJson2);

    // Create set-parameters.json that does NOT output test_param
    const setParametersTemplateNoOutput = {
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
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-app-2/templates/set-parameters-no-output.json", setParametersTemplateNoOutput);

    // Copy optional-template-single.json
    const optionalTemplateSingle = {
      "execute_on": "ve",
      "name": "Optional Template Single",
      "description": "Optional template with single parameter",
      "skip_if_all_missing": ["test_param"],
      "parameters": [
        {
          "id": "test_param",
          "name": "Test Parameter",
          "type": "string",
          "required": true,
          "description": "Test parameter"
        }
      ],
      "commands": [
        {
          "name": "Test Command",
          "command": "echo 'test command executed'"
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-app-2/templates/optional-template-single.json", optionalTemplateSingle);

    const loaded = await tp.loadApplication(
      "test-skip-app-2",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // test_param is NOT provided, so the template should be skipped
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("(skipped)") && cmd.command === "exit 0"
    );

    expect(skippedCommand).toBeDefined();
    expect(skippedCommand?.name).toContain("(skipped)");
    expect(skippedCommand?.command).toBe("exit 0");
    expect(skippedCommand?.description).toContain("Skipped");
    
    // Cleanup handled by env.cleanup()
  });

  it("should skip template with multiple parameters when ALL are missing", async () => {
    // param1 and param2 are not provided by set-parameters.json (only test_param is),
    // so the template should be skipped
    const loaded = await tp.loadApplication(
      "test-skip-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // param1 and param2 are not provided, so the template should be skipped
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("(skipped)") && cmd.command === "exit 0"
    );

    expect(skippedCommand).toBeDefined();
    expect(skippedCommand?.name).toContain("(skipped)");
    expect(skippedCommand?.command).toBe("exit 0");
    expect(skippedCommand?.description).toContain("Skipped");
  });

  it("should NOT skip template with multiple parameters when at least one is present", async () => {
    const appId = "test-skip-app-3";
    const templatesDir = persistenceHelper.resolve(Volume.JsonApplications, `${appId}/templates`);
    fs.mkdirSync(templatesDir, { recursive: true });

    const applicationJson = {
      "name": "Test Skip Application 3",
      "description": "Test application for skip_if_all_missing - at least one present",
      "installation": [
        "set-parameters.json",
        "optional-template-multiple.json"
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, `${appId}/application.json`, applicationJson);

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
              "id": "test_param",
              "value": "test-value"
            },
            {
              "id": "param1",
              "value": "param1-value"
            }
          ]
        }
      ]
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      `${appId}/templates/set-parameters.json`,
      setParametersTemplate,
    );

    const optionalTemplateMultiple = {
      "execute_on": "ve",
      "name": "Optional Template Multiple",
      "description": "Optional template with multiple parameters",
      "skip_if_all_missing": ["param1", "param2"],
      "parameters": [
        {
          "id": "param1",
          "name": "Parameter 1",
          "type": "string",
          "required": false,
          "description": "First parameter"
        },
        {
          "id": "param2",
          "name": "Parameter 2",
          "type": "string",
          "required": false,
          "description": "Second parameter"
        }
      ],
      "commands": [
        {
          "name": "Test Command Multiple",
          "command": "echo 'test command multiple executed'"
        }
      ]
    };
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      `${appId}/templates/optional-template-multiple.json`,
      optionalTemplateMultiple,
    );

    const loaded = await tp.loadApplication(
      appId,
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // param1 is provided, so the template should NOT be skipped
    // (even though param2 is missing, at least one is present)
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("Optional Template Multiple") && cmd.name.includes("(skipped)")
    );

    expect(skippedCommand).toBeUndefined();
    
    // There should be a regular command instead (not skipped)
    const regularCommand = loaded.commands.find((cmd: any) => 
      cmd.name === "Test Command Multiple" && !cmd.name.includes("(skipped)")
    );
    
    expect(regularCommand).toBeDefined();
    expect(regularCommand?.command).toBe("echo 'test command multiple executed'");
  });
});

