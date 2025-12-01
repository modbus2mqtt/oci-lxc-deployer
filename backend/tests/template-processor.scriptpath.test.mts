import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { VeConfiguration } from "../src/ve-configuration.mjs";
import fs from "fs";
import * as path from "path";
import os from "node:os";
import { TemplateProcessor } from "@src/templateprocessor.mjs";

describe("ProxmoxConfiguration script path resolution", () => {
  const tmp = os.tmpdir();
  const appName = "testapp";
  const scriptName = "myscript.sh";
  const scriptContent = "echo {{ param }}";
  const schemaPath = path.join(tmp, "schema");
  const jsonPath = path.join(tmp, "json");
  const localPath = path.join(tmp, "local/json");
  const appDir = path.join(jsonPath, "applications", appName);
  const scriptsDir = path.join(appDir, "scripts");
  const appJsonPath = path.join(appDir, "application.json");
  const templateDir = path.join(appDir, "templates");
  const templatePath = path.join(templateDir, "install.json");
  const scriptPath = path.join(scriptsDir, scriptName);

  beforeAll(() => {
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(templateDir, { recursive: true });
    fs.mkdirSync(schemaPath, { recursive: true });
    fs.mkdirSync(localPath, { recursive: true });
    fs.writeFileSync(scriptPath, scriptContent);
    fs.writeFileSync(
      appJsonPath,
      JSON.stringify({
        name: appName,
        installation: ["install.json"],
      }),
    );
    fs.writeFileSync(
      templatePath,
      JSON.stringify({
        commands: [{ script: scriptName, execute_on: "proxmox" }],
        parameters: [{ id: "param", name: "param", type: "string" }],
        outputs: [],
      }),
    );
    fs.writeFileSync(
      path.join(schemaPath, "application.schema.json"),
      '{"type":"object"}',
    );
    fs.writeFileSync(
      path.join(schemaPath, "template.schema.json"),
      '{"type":"object"}',
    );
  });

  afterAll(() => {
    fs.rmSync(jsonPath, { recursive: true, force: true });
    fs.rmSync(schemaPath, { recursive: true, force: true });
  });

  it("should resolve script path in commands", () => {
    const config = new VeConfiguration(schemaPath, jsonPath, localPath);
    const templateProcessor = new TemplateProcessor(config);

    const result = templateProcessor.loadApplication(appName, "installation");
    const scriptCmd = result.commands.find((cmd) => cmd.script !== undefined);
    expect(scriptCmd).toBeDefined();
    expect(scriptCmd!.script).toBe(scriptPath);
  });
});
