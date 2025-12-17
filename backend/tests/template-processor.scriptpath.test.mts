import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import * as path from "path";
import { ProxmoxTestHelper } from "@tests/ve-test-helper.mjs";

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
    // IMPORTANT: StorageContext now only uses dynamic localPath. Ensure we write into local/applications.
    appDir = path.join(helper.localDir, "applications", appName);
    scriptsDir = path.join(appDir, "scripts");
    appJsonPath = path.join(appDir, "application.json");
    templateDir = path.join(appDir, "templates");
    templatePath = path.join(templateDir, "install.json");
    scriptPath = path.join(scriptsDir, scriptName);
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.mkdirSync(templateDir, { recursive: true });
    fs.writeFileSync(scriptPath, scriptContent);
    fs.writeFileSync(
      appJsonPath,
      JSON.stringify({
        name: appName,
        installation: ["install.json", "010-get-latest-os-template.json"],
      }),
    );
    fs.writeFileSync(
      templatePath,
      JSON.stringify({
        execute_on: "ve",
        name: "Install",
        commands: [{ script: scriptName }],
        parameters: [{ id: "param", name: "param", type: "string" }],
        outputs: [],
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
      "sh",
    );
    const scriptCmd = result.commands.find((cmd) => cmd.script !== undefined);
    expect(scriptCmd).toBeDefined();
    expect(scriptCmd!.script).toBe(scriptPath);

    // Also verify shared template from backend/json/shared/templates is picked up
    const expectedSharedScript = path.join(
      __dirname,
      "../json/shared/scripts/get-latest-os-template.sh",
    );
    const sharedCmd = result.commands.find(
      (cmd) => cmd.script === expectedSharedScript,
    );
    expect(sharedCmd).toBeDefined();
  });
});
