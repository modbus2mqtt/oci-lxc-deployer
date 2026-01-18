import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import * as path from "path";
import { ProxmoxTestHelper } from "@tests/ve-test-helper.mjs";
import { ExecutionMode } from "@src/ve-execution-constants.mjs";

describe("ProxmoxConfiguration script path resolution", () => {
  const appName = "testapp";
  const scriptName = "myscript.sh";
  const scriptContent = "echo {{ param }}";
  let helper: ProxmoxTestHelper;
  let appDir: string;
  let scriptsDir: string;
  let appJsonPath: string;
  let templateDir: string;
  let templatePath: string;
  let scriptPath: string;

  beforeAll(async () => {
    helper = new ProxmoxTestHelper();
    await helper.setup();
    
    // Create application structure in localDir first (before any watchers start)
    appDir = path.join(helper.localDir, "applications", appName);
    scriptsDir = path.join(appDir, "scripts");
    appJsonPath = path.join(appDir, "application.json");
    templateDir = path.join(appDir, "templates");
    templatePath = path.join(templateDir, "install.json");
    scriptPath = path.join(scriptsDir, scriptName);
    
    // Create all directories at once to avoid race conditions with file watchers
    await fs.promises.mkdir(scriptsDir, { recursive: true });
    await fs.promises.mkdir(templateDir, { recursive: true });
    
    // Write all files after directories are created
    await fs.promises.writeFile(scriptPath, scriptContent);
    await fs.promises.writeFile(
      appJsonPath,
      JSON.stringify({
        name: appName,
        installation: ["install.json", "010-get-latest-os-template.json"],
      }),
    );
    await fs.promises.writeFile(
      templatePath,
      JSON.stringify({
        execute_on: "ve",
        name: "Install",
        commands: [{ script: scriptName }],
        parameters: [{ id: "param", name: "param", type: "string", description: "Test parameter" }],
      }),
    );
  });

  afterAll(async () => {
    await helper.cleanup();
  });

  it("should resolve script path in commands", async () => {
    const templateProcessor = helper.createTemplateProcessor();
    const result = await templateProcessor.loadApplication(
      appName,
      "installation",
      { host: "localhost", port: 22 } as any,
      ExecutionMode.TEST,
    );
    const scriptCmd = result.commands.find((cmd) => cmd.script !== undefined);
    expect(scriptCmd).toBeDefined();
    expect(scriptCmd!.script).toBe(scriptPath);

    // Also verify shared template from json/shared/templates is picked up
    const expectedSharedScript = path.join(
      __dirname,
      "../../",
    );
    const sharedCmd = result.commands.find(
      (cmd) => cmd.script?.endsWith("json/shared/scripts/get-latest-os-template.sh")
    );
    expect(sharedCmd).toBeDefined();
  });
});
