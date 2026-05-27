// Reproduction for the production bug: pve1.cluster (Hub) carries the project's
// property defaults in /config/shared/templates/create_ct/050-set-project-parameters.json
// (vm_id_start=500, etc), but containers created from local Spokes still see
// the bundled defaults — never the Hub's overrides.
//
// On the Spoke filesystem the Hub's local/ tree is synced into
// <spokeLocal>/.hubs/<hub-id>/local; PersistenceManager exposes that path as
// `hubPath`. resolveTemplatePath searches localPath → hubPath → jsonPath, so
// when the Spoke has no override of its own, hubPath should provide the
// project's property defaults.
//
// This test mirrors the existing "/config override" test (which uses
// localPath) but writes the override under hubPath only. If it fails, we have
// a tight reproduction of the bug. If it passes, the bug lives outside the
// template-resolution layer (e.g. spoke-sync did not run, or storagecontext
// has no isHub entry).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templates/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

describe("TemplateProcessor: hubPath property-default override (Spoke sync)", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let hubDir: string;
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

    // Bundled default in json/shared/ — placeholder default.
    const sharedCreateCtDir = persistenceHelper.resolve(
      Volume.JsonSharedTemplates,
      "create_ct",
    );
    fs.mkdirSync(sharedCreateCtDir, { recursive: true });
    fs.writeFileSync(
      `${sharedCreateCtDir}/050-set-defaults.json`,
      JSON.stringify(
        {
          name: "Set Defaults",
          description: "Bundled property defaults (placeholder values)",
          commands: [
            { properties: [{ id: "test_override_var", default: "BUNDLED" }] },
          ],
        },
        null,
        2,
      ),
    );

    // Hub-synced override under hubPath (mirrors
    // <spokeLocal>/.hubs/<hub-id>/local/shared/templates/create_ct/...)
    hubDir = fs.mkdtempSync(path.join(os.tmpdir(), "proxvex-hub-"));
    const hubSharedCreateCtDir = path.join(
      hubDir,
      "shared",
      "templates",
      "create_ct",
    );
    fs.mkdirSync(hubSharedCreateCtDir, { recursive: true });
    fs.writeFileSync(
      `${hubSharedCreateCtDir}/050-set-defaults.json`,
      JSON.stringify(
        {
          name: "Set Defaults",
          description: "Hub project-specific defaults",
          commands: [
            { properties: [{ id: "test_override_var", default: "FROM_HUB" }] },
          ],
        },
        null,
        2,
      ),
    );

    // Consumer template — declares the parameter so applyPropertyDefaults has
    // a target to write into.
    const sharedPreStartDir = persistenceHelper.resolve(
      Volume.JsonSharedTemplates,
      "pre_start",
    );
    fs.mkdirSync(sharedPreStartDir, { recursive: true });
    fs.writeFileSync(
      `${sharedPreStartDir}/150-consume-default.json`,
      JSON.stringify(
        {
          name: "Consume Default",
          description: "Declares test_override_var",
          execute_on: "ve",
          parameters: [
            {
              id: "test_override_var",
              name: "Test Override Var",
              type: "string",
              required: false,
              default: "PARAM_DEFAULT",
              description: "Receives the property default",
            },
          ],
          commands: [{ name: "Consume", script: "consume.sh" }],
        },
        null,
        2,
      ),
    );
    const sharedScriptsDir = persistenceHelper.resolve(
      Volume.JsonSharedScripts,
      "pre_start",
    );
    fs.mkdirSync(sharedScriptsDir, { recursive: true });
    fs.writeFileSync(
      `${sharedScriptsDir}/consume.sh`,
      "#!/bin/sh\necho ok\n",
    );

    const application = {
      name: "Spoke Hub Drift App",
      description: "Reproduction: hub property-default invisible to spoke",
      installation: {
        create_ct: ["050-set-defaults.json"],
        pre_start: ["150-consume-default.json"],
      },
    };
    const appDir = persistenceHelper.resolve(
      Volume.JsonApplications,
      "spoke-hub-drift-app",
    );
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      `${appDir}/application.json`,
      JSON.stringify(application, null, 2),
    );

    // env.initPersistence() does not accept a hubPath — initialize PM
    // directly so search order becomes localPath → hubDir → jsonPath.
    try {
      PersistenceManager.getInstance().close();
    } catch {
      /* not initialized yet */
    }
    const pm = PersistenceManager.initialize(
      env.localDir,
      env.storageContextFilePath,
      env.secretFilePath,
      true,
      env.jsonDir,
      env.schemaDir,
      undefined,
      hubDir,
    );
    tp = pm.getContextManager().getTemplateProcessor();
  });

  afterAll(() => {
    env?.cleanup();
    try {
      fs.rmSync(hubDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("hub property default wins when localPath has no override", async () => {
    const loaded = await tp.loadApplication(
      "spoke-hub-drift-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    const param = loaded.parameters.find((p) => p.id === "test_override_var");
    expect(param).toBeDefined();
    expect(param?.default).toBe("FROM_HUB");
  });
});
