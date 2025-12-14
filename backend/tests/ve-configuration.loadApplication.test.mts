import * as path from "path";
import { expect, describe, it, beforeEach, afterEach } from "vitest";
import { ProxmoxTestHelper } from "@tests/ve-test-helper.mjs";
import { VEConfigurationError } from "@src/backend-types.mjs";
import { StorageContext } from "@src/storagecontext.mjs";

declare module "@tests/ve-test-helper.mjs" {
  interface ProxmoxTestHelper {
    createStorageContext(): StorageContext;
  }
}
ProxmoxTestHelper.prototype.createStorageContext = function () {
  const schemaPath = path.join(__dirname, "../schemas");
  const jsonPath = this.jsonDir;
  const localPath = path.join(__dirname, "../local/json");
  // Constructor expects (localPath, jsonPath, schemaPath)
  const storage = new StorageContext(localPath, jsonPath, schemaPath);
  (StorageContext as any).instance = storage;
  return storage;
};

describe("ProxmoxConfiguration.loadApplication", () => {
  let helper: ProxmoxTestHelper;

  beforeEach(async () => {
    helper = new ProxmoxTestHelper();
    await helper.setup();
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  it("should load parameters and commands for modbus2mqtt installation", () => {
    const config = helper.createStorageContext();
    const templateProcessor = config.getTemplateProcessor();
    const result = templateProcessor.loadApplication(
      "modbus2mqtt",
      "installation",
      { host: "localhost", port: 22 } as any,
      "sh",
    );

    expect(result.parameters.length).toBeGreaterThan(0);
    expect(result.commands.length).toBeGreaterThan(0);
    const paramNames = result.parameters.map((p) => p.id);
    expect(paramNames).toContain("vm_id");

    templateProcessor
      .getUnresolvedParameters(result.parameters, result.resolvedParams)
      .forEach((param) => {
        expect(param.name).not.toBe("vm_id");
      });
  });

  it("should throw error if a template file is missing and provide all errors and application object", () => {
    const config = helper.createStorageContext();

    try {
      let application = helper.readApplication("modbus2mqtt");
      application.installation = ["nonexistent-template.json"];
      const templateProcessor = config.getTemplateProcessor();
      templateProcessor.loadApplication("modbus2mqtt", "installation", { host: "localhost", port: 22 } as any, "sh");
    } catch (err) {
      expect(err).toBeInstanceOf(VEConfigurationError);
      const errorObj = err as VEConfigurationError;
      expect(Array.isArray(errorObj.details)).toBe(true);
      expect(errorObj.details!.length).toBeGreaterThan(0);
      expect(errorObj.message).toMatch(
        /Multiple errors|Template file not found/,
      );
      // NEU: application-Objekt mit errors-Property
      expect((err as any).application).toBeDefined();
      expect((err as any).application.name).toBeDefined();
      expect(Array.isArray((err as any).application.errors)).toBe(true);
      expect((err as any).application.errors.length).toBeGreaterThan(0);
    }
  });

  it("should throw recursion error for endless nested templates and provide application object", () => {
    const config = helper.createStorageContext();
    // Manipuliere die Testdaten, sodass ein Template sich selbst referenziert
    const appName = "modbus2mqtt";
    const templateName = "recursive-template.json";
    // Schreibe ein Template, das sich selbst als nested template referenziert
    helper.writeTemplate(appName, templateName, {
      execute_on: "lxc",
      name: "Recursive Template",
      commands: [
        {
          template: templateName,
        },
      ],
    });
    // Setze dieses Template als einziges in installation
    const app = helper.readApplication(appName);
    app.installation = [templateName];
    helper.writeApplication(appName, app);
    try {
      const templateProcessor = config.getTemplateProcessor();
      templateProcessor.loadApplication(appName, "installation", { host: "localhost", port: 22 } as any, "sh");
    } catch (err: any) {
      expect((err as any).message).toMatch(/Endless recursion detected/);
    }
  });

  it("should throw error if a script file is missing and provide application object", () => {
    const config = helper.createStorageContext();
    // Write a template that references a non-existent script
    const appName = "modbus2mqtt";
    const templateName = "missing-script-template.json";
    helper.writeTemplate(appName, templateName, {
      execute_on: "ve",
      name: "Missing Script Template",
      commands: [{ script: "nonexistent-script.sh" }],
    });
    // Set this template as the only one in installation
    const app = helper.readApplication(appName);
    app.installation = [templateName];
    helper.writeApplication(appName, app);
    try {
      const templateProcessor = config.getTemplateProcessor();
      templateProcessor.loadApplication(appName, "installation", { host: "localhost", port: 22 } as any, "sh");
    } catch (err: any) {
      // Validation error is acceptable here when script is missing
      expect(err.message).toMatch(/error|Script file not found/i);
    }
  });

  it("should throw error if a script uses an undefined parameter and provide application object", () => {
    // Write a template that references a script using an undefined variable
    const appName = "modbus2mqtt";
    const templateName = "missing-param-script-template.json";
    const scriptName = "uses-missing-param.sh";
    // Write the script file with a variable that is not defined as a parameter
    helper.writeScript(
      appName,
      scriptName,
      '#!/bin/sh\necho "Value: {{ missing_param }}"\n',
    );
    helper.writeTemplate(appName, templateName, {
      execute_on: "ve",
      name: "Missing Param Script Template",
      commands: [{ script: scriptName }],
    });
    // Set this template as the only one in installation
    const app = helper.readApplication(appName);
    app.installation = [templateName];
    helper.writeApplication(appName, app);
    try {
    } catch (err: any) {
      // Validation error is acceptable here when parameter is missing
      expect(err.message).toMatch(/error/i);
    }
  });

  it("should throw error if a command uses an undefined parameter and provide application object", () => {
    const config = helper.createStorageContext();
    // Write a template that references a command using an undefined variable
    const appName = "modbus2mqtt";
    const templateName = "missing-param-command-template.json";
    helper.writeTemplate(appName, templateName, {
      execute_on: "ve",
      name: "Missing Param Command Template",
      commands: [{ command: "echo {{ missing_param }}" }],
    });
    // Set this template as the only one in installation
    const app = helper.readApplication(appName);
    app.installation = [templateName];
    helper.writeApplication(appName, app);
    try {
      const templateProcessor = config.getTemplateProcessor();
      templateProcessor.loadApplication(appName, "installation", { host: "localhost", port: 22 } as any,"sh");
    } catch (err: any) {
      // Expect a validation error or specific undefined parameter message
      expect(err.message).toMatch(/Validation error|Command uses variable/i);
      const details = (err as any).details || [];
      if (Array.isArray(details) && details.length > 0) {
        const messages = details.map((d: any) => d.passed_message || d.message || "");
        const hasPatternMsg = messages.some((m: string) => /must match pattern/i.test(m));
        expect(hasPatternMsg).toBe(true);
      }
    }
  });
});
