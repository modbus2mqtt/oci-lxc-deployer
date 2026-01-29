import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templates/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

describe("TemplateProcessor skip_if_property_set", () => {
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

    const templatesDir = persistenceHelper.resolve(Volume.JsonApplications, "test-skip-property-set-app/templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    // Create application.json
    const applicationJson = {
      "name": "Test Skip Property Set Application",
      "description": "Test application for skip_if_property_set",
      "installation": [
        "set-parameters.json",
        "skip-if-property-set-template.json"
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-property-set-app/application.json", applicationJson);

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
              "id": "myvariable",
              "value": "test-value"
            }
          ]
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-property-set-app/templates/set-parameters.json", setParametersTemplate);

    // Create skip-if-property-set-template.json - should be skipped if myvariable is set
    const skipIfPropertySetTemplate = {
      "execute_on": "ve",
      "name": "Skip If Property Set Template",
      "description": "Template that is skipped if myvariable is set",
      "skip_if_property_set": "myvariable",
      "parameters": [
        {
          "id": "other_param",
          "name": "Other Parameter",
          "type": "string",
          "required": false,
          "description": "Other parameter"
        }
      ],
      "commands": [
        {
          "name": "Test Command",
          "command": "echo 'test command executed'"
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-property-set-app/templates/skip-if-property-set-template.json", skipIfPropertySetTemplate);

    const { ctx } = env.initPersistence({ enableCache: false });
    contextManager = ctx;
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    env?.cleanup();
  });

  it("should skip template when skip_if_property_set variable is set", async () => {
    // myvariable is provided by set-parameters.json (via properties command),
    // so it should be in resolvedParams when skip-if-property-set-template.json is processed.
    // Therefore, the template should be skipped.
    
    const loaded = await tp.loadApplication(
      "test-skip-property-set-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // Verify myvariable is in resolvedParams (it should be, because set-parameters.json outputs it)
    const resolvedParamIds = loaded.resolvedParams.map((p: any) => p.id);
    expect(resolvedParamIds).toContain("myvariable");
    
    // Since myvariable is present, the template should be skipped
    // The command name will be "Test Command (skipped)" because cmd.name is used
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("(skipped)") && cmd.command === "exit 0"
    );
    
    expect(skippedCommand).toBeDefined();
    expect(skippedCommand?.command).toBe("exit 0");
    expect(skippedCommand?.description).toContain("Skipped");
    
    // There should NOT be a regular command
    const regularCommand = loaded.commands.find((cmd: any) => 
      cmd.name === "Test Command" && !cmd.name.includes("(skipped)")
    );
    
    expect(regularCommand).toBeUndefined();
  });

  it("should NOT skip template when skip_if_property_set variable is NOT set", async () => {
    // Create a separate application for this test to avoid side effects
    const templatesDir2 = persistenceHelper.resolve(Volume.JsonApplications, "test-skip-property-set-app-2/templates");
    fs.mkdirSync(templatesDir2, { recursive: true });

    // Create application.json
    const applicationJson2 = {
      "name": "Test Skip Property Set Application 2",
      "description": "Test application for skip_if_property_set - variable not set",
      "installation": [
        "set-parameters-no-myvariable.json",
        "skip-if-property-set-template.json"
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-property-set-app-2/application.json", applicationJson2);

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
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-property-set-app-2/templates/set-parameters-no-myvariable.json", setParametersTemplateNoMyVariable);

    // Copy skip-if-property-set-template.json
    const skipIfPropertySetTemplate = {
      "execute_on": "ve",
      "name": "Skip If Property Set Template",
      "description": "Template that is skipped if myvariable is set",
      "skip_if_property_set": "myvariable",
      "parameters": [
        {
          "id": "other_param",
          "name": "Other Parameter",
          "type": "string",
          "required": false,
          "description": "Other parameter"
        }
      ],
      "commands": [
        {
          "name": "Test Command",
          "command": "echo 'test command executed'"
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-skip-property-set-app-2/templates/skip-if-property-set-template.json", skipIfPropertySetTemplate);

    const loaded = await tp.loadApplication(
      "test-skip-property-set-app-2",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // myvariable is NOT provided, so the template should NOT be skipped
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("Skip If Property Set Template") && cmd.name.includes("(skipped)")
    );

    expect(skippedCommand).toBeUndefined();
    
    // There should be a regular command instead
    const regularCommand = loaded.commands.find((cmd: any) => 
      cmd.name === "Test Command" && !cmd.name.includes("(skipped)")
    );
    
    expect(regularCommand).toBeDefined();
    expect(regularCommand?.command).toBe("echo 'test command executed'");
    
    // Cleanup handled by env.cleanup()
  });
});

