import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templateprocessor.mjs";
import { VELoadApplicationError, VEConfigurationError } from "@src/backend-types.mjs";
import { JsonError } from "@src/jsonvalidator.mjs";
import { ExecutionMode } from "@src/ve-execution-constants.mjs";

describe("TemplateProcessor duplicate validation", () => {
  let testDir: string;
  let secretFilePath: string;
  let contextManager: ReturnType<typeof PersistenceManager.getInstance>["getContextManager"];
  let tp: TemplateProcessor;
  const veContext = { host: "validation-dummy", current: false, getStorageContext: () => PersistenceManager.getInstance().getContextManager() as any, getKey: () => "ve_validation-dummy" } as any;

  beforeAll(() => {
    // Create a temporary directory for the test
    testDir = mkdtempSync(path.join(tmpdir(), "templateprocessor-duplicate-test-"));
    secretFilePath = path.join(testDir, "secret.txt");

    const __filename = new URL(import.meta.url).pathname;
    const backendDir = path.dirname(__filename);
    const repoRoot = path.join(backendDir, "../..");
    const jsonDir = path.join(testDir, "json");
    const schemaDir = path.join(repoRoot, "schemas");
    const applicationsDir = path.join(jsonDir, "applications");
    const testAppDir = path.join(applicationsDir, "test-duplicate-app");
    const templatesDir = path.join(testAppDir, "templates");
    
    mkdirSync(templatesDir, { recursive: true });

    // Create a valid storagecontext.json file
    const storageContextPath = path.join(testDir, "storagecontext.json");
    writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

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
      rmSync(testDir, { recursive: true, force: true });
    } catch (e) {
      // Ignore cleanup errors
    }
  });

  it("should detect duplicate templates in the same task", async () => {
    const jsonDir = path.join(testDir, "json");
    const testAppDir = path.join(jsonDir, "applications", "test-duplicate-app");
    const templatesDir = path.join(testAppDir, "templates");

    // Create application.json with duplicate template
    const applicationJson = {
      "name": "Test Duplicate Template Application",
      "description": "Test application for duplicate template detection",
      "installation": [
        "template-a.json",
        "template-b.json",
        "template-a.json"  // Duplicate
      ]
    };
    writeFileSync(
      path.join(testAppDir, "application.json"),
      JSON.stringify(applicationJson),
      "utf-8"
    );

    // Create template-a.json
    const templateA = {
      "execute_on": "lxc",
      "name": "Template A",
      "commands": [
        {
          "properties": [
            {
              "id": "param_a",
              "value": "value_a"
            }
          ]
        }
      ]
    };
    writeFileSync(
      path.join(templatesDir, "template-a.json"),
      JSON.stringify(templateA),
      "utf-8"
    );

    // Create template-b.json
    const templateB = {
      "execute_on": "lxc",
      "name": "Template B",
      "commands": [
        {
          "properties": [
            {
              "id": "param_b",
              "value": "value_b"
            }
          ]
        }
      ]
    };
    writeFileSync(
      path.join(templatesDir, "template-b.json"),
      JSON.stringify(templateB),
      "utf-8"
    );

    // Try to load the application - should throw error about duplicate template
    // The error is thrown during readApplicationJson, so it's a JsonError wrapped in VELoadApplicationError
    await expect(
      tp.loadApplication("test-duplicate-app", "installation", veContext, ExecutionMode.TEST)
    ).rejects.toThrow();

    try {
      await tp.loadApplication("test-duplicate-app", "installation", veContext, ExecutionMode.TEST);
    } catch (err: any) {
      // The error can be either JsonError (from readApplicationJson) or VELoadApplicationError
      expect(err).toBeInstanceOf(Error);
      
      // Check error message contains information about duplicate template
      const errorMessage = err.message || String(err);
      expect(errorMessage).toContain("template-a.json");
      expect(errorMessage).toContain("appears multiple times");
      expect(errorMessage).toContain("installation");
    }
  });

  it("should detect duplicate output IDs from different templates in the same task", async () => {
    const jsonDir = path.join(testDir, "json");
    const testAppDir = path.join(jsonDir, "applications", "test-duplicate-app");
    const templatesDir = path.join(testAppDir, "templates");

    // Create application.json with two templates that set the same output IDs
    const applicationJson = {
      "name": "Test Duplicate Output IDs Application",
      "description": "Test application for duplicate output ID detection",
      "installation": [
        "set-db-params-a.json",
        "set-db-params-b.json"
      ]
    };
    writeFileSync(
      path.join(testAppDir, "application.json"),
      JSON.stringify(applicationJson),
      "utf-8"
    );

    // Create set-db-params-a.json - sets db_user, db_password, db_name
    const templateA = {
      "execute_on": "lxc",
      "name": "Set DB Params A",
      "commands": [
        {
          "properties": [
            {
              "id": "db_user",
              "value": "user_a"
            },
            {
              "id": "db_password",
              "value": "password_a"
            },
            {
              "id": "db_name",
              "value": "database_a"
            }
          ]
        }
      ]
    };
    writeFileSync(
      path.join(templatesDir, "set-db-params-a.json"),
      JSON.stringify(templateA),
      "utf-8"
    );

    // Create set-db-params-b.json - also sets db_user, db_password, db_name (duplicate IDs)
    const templateB = {
      "execute_on": "lxc",
      "name": "Set DB Params B",
      "commands": [
        {
          "properties": [
            {
              "id": "db_user",
              "value": "user_b"
            },
            {
              "id": "db_password",
              "value": "password_b"
            },
            {
              "id": "db_name",
              "value": "database_b"
            }
          ]
        }
      ]
    };
    writeFileSync(
      path.join(templatesDir, "set-db-params-b.json"),
      JSON.stringify(templateB),
      "utf-8"
    );

    // Try to load the application - should throw error about duplicate output IDs
    // The error is thrown during template processing, so it's a VEConfigurationError
    await expect(
      tp.loadApplication("test-duplicate-app", "installation", veContext)
    ).rejects.toThrow(VEConfigurationError);

    try {
      await tp.loadApplication("test-duplicate-app", "installation", veContext, ExecutionMode.TEST);
    } catch (err: any) {
      expect(err).toBeInstanceOf(VEConfigurationError);
      expect(err.details).toBeDefined();
      expect(Array.isArray(err.details)).toBe(true);
      expect(err.details.length).toBeGreaterThanOrEqual(3); // At least 3 errors (db_user, db_password, db_name)
      
      // Check that error messages contain information about duplicate output IDs
      const errorMessages = err.details.map((d: any) => d.message || String(d));
      
      // Should have errors for db_user, db_password, and db_name
      const dbUserError = errorMessages.find((msg: string) => 
        msg.includes("db_user") && msg.includes("set by multiple templates")
      );
      const dbPasswordError = errorMessages.find((msg: string) => 
        msg.includes("db_password") && msg.includes("set by multiple templates")
      );
      const dbNameError = errorMessages.find((msg: string) => 
        msg.includes("db_name") && msg.includes("set by multiple templates")
      );
      
      expect(dbUserError).toBeDefined();
      expect(dbPasswordError).toBeDefined();
      expect(dbNameError).toBeDefined();
      
      // Check that both templates are mentioned in the error
      expect(dbUserError).toContain("set-db-params-a.json");
      expect(dbUserError).toContain("set-db-params-b.json");
    }
  });
});

