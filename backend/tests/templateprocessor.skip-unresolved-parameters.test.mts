import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution-constants.mjs";

describe("TemplateProcessor - Parameters from skipped templates should not appear in unresolved parameters", () => {
  let testDir: string;
  let secretFilePath: string;
  let contextManager: ReturnType<typeof PersistenceManager.getInstance>["getContextManager"];
  let tp: TemplateProcessor;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    // Create a temporary directory for the test
    testDir = mkdtempSync(path.join(tmpdir(), "templateprocessor-skip-unresolved-params-test-"));
    secretFilePath = path.join(testDir, "secret.txt");

    // Use an isolated json directory inside the temp testDir to avoid
    // mutating the repository json and to prevent cross-test races in CI
    const __filename = new URL(import.meta.url).pathname;
    const backendDir = path.dirname(__filename);
    const repoRoot = path.join(backendDir, "../..");
    const jsonDir = path.join(testDir, "json");
    const schemaDir = path.join(repoRoot, "schemas");
    const applicationsDir = path.join(jsonDir, "applications");
    const testAppDir = path.join(applicationsDir, "test-skip-unresolved-app");
    const templatesDir = path.join(testAppDir, "templates");
    
    mkdirSync(templatesDir, { recursive: true });

    // Create a valid storagecontext.json file
    const storageContextPath = path.join(testDir, "storagecontext.json");
    writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

    // Create application.json
    const applicationJson = {
      "name": "Test Skip Unresolved Parameters Application",
      "description": "Test application for skipped template parameters",
      "installation": [
        "set-parameters.json",
        "skipped-template.json"
      ]
    };
    writeFileSync(
      path.join(testAppDir, "application.json"),
      JSON.stringify(applicationJson),
      "utf-8"
    );

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
    writeFileSync(
      path.join(templatesDir, "set-parameters.json"),
      JSON.stringify(setParametersTemplate),
      "utf-8"
    );

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
    writeFileSync(
      path.join(templatesDir, "skipped-template.json"),
      JSON.stringify(skippedTemplate),
      "utf-8"
    );

    // Close existing instance if any
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
    // Initialize with isolated json/schema paths
    PersistenceManager.initialize(
      testDir,
      storageContextPath,
      secretFilePath,
      false,
      jsonDir,
      schemaDir,
    );
    const pm = PersistenceManager.getInstance();
    contextManager = pm.getContextManager();
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    try {
      if (testDir && require("fs").existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
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
    const applicationsDir = path.join(testDir, "json", "applications");
    const testAppDir2 = path.join(applicationsDir, "test-skip-unresolved-app-2");
    const templatesDir2 = path.join(testAppDir2, "templates");
    
    mkdirSync(templatesDir2, { recursive: true });

    // Create application.json
    const applicationJson2 = {
      "name": "Test Skip Unresolved Parameters Application 2",
      "description": "Test application for skipped template parameters - variable not set",
      "installation": [
        "set-parameters-no-myvariable.json",
        "skip-if-property-set-template.json"
      ]
    };
    writeFileSync(
      path.join(testAppDir2, "application.json"),
      JSON.stringify(applicationJson2),
      "utf-8"
    );

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
    writeFileSync(
      path.join(templatesDir2, "set-parameters-no-myvariable.json"),
      JSON.stringify(setParametersTemplateNoMyVariable),
      "utf-8"
    );

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
    writeFileSync(
      path.join(templatesDir2, "skip-if-property-set-template.json"),
      JSON.stringify(skipIfPropertySetTemplate),
      "utf-8"
    );

    // Get unresolved parameters
    const unresolved = await tp.getUnresolvedParameters(
      "test-skip-unresolved-app-2",
      "installation",
      veContext,
    );

    // Parameters from skip-if-property-set-template.json SHOULD appear because template is NOT skipped
    const unresolvedIds = unresolved.map((p: any) => p.id);
    expect(unresolvedIds).toContain("not_skipped_param");

    // Cleanup
    rmSync(testAppDir2, { recursive: true, force: true });
  });
});

