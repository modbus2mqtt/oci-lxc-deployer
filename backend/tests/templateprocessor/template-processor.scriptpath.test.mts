import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "path";
import { VeTestHelper } from "@tests/helper/ve-test-helper.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

describe("ProxmoxConfiguration script path resolution", () => {
  const appName = "testapp";
  const scriptName = "myscript.sh";
  const scriptContent = "echo {{ param }}";
  let helper: VeTestHelper;
  let persistenceHelper: TestPersistenceHelper;
  let appDir: string;
  let scriptsDir: string;
  let scriptPath: string;

  beforeAll(async () => {
    helper = new VeTestHelper();
    await helper.setup();
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: helper.tempDir,
      localRoot: helper.localDir,
      jsonRoot: helper.jsonDir,
      schemasRoot: helper.schemaDir,
    });

    // Create application structure in localDir first (before any watchers start)
    appDir = path.join(helper.localDir, "applications", appName);
    scriptsDir = path.join(appDir, "scripts");
    scriptPath = path.join(scriptsDir, scriptName);

    // Write all files via helper (ensures dirs are created)
    persistenceHelper.writeTextSync(
      Volume.LocalRoot,
      `applications/${appName}/scripts/${scriptName}`,
      scriptContent,
    );
    persistenceHelper.writeJsonSync(
      Volume.LocalRoot,
      `applications/${appName}/application.json`,
      {
        name: appName,
        installation: { post_start: ["install.json", "010-host-get-latest-os-template.json"] },
      },
    );
    persistenceHelper.writeJsonSync(
      Volume.LocalRoot,
      `applications/${appName}/templates/install.json`,
      {
        execute_on: "ve",
        name: "Install",
        commands: [{ script: scriptName }],
        parameters: [
          {
            id: "param",
            name: "param",
            type: "string",
            description: "Test parameter",
          },
        ],
      },
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
    // Scripts are now organized in category subdirectories
    const expectedSharedScript = path.join(
      helper.jsonDir,
      "shared",
      "scripts",
      "image",
      "host-get-latest-os-template.sh",
    );
    const sharedCmd = result.commands.find(
      (cmd) => cmd.script === expectedSharedScript,
    );
    expect(sharedCmd).toBeDefined();
  });
});
