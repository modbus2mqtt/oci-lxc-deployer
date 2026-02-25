import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { ContextManager } from "@src/context-manager.mjs";
import { IPostFrameworkCreateApplicationBody } from "@src/types.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

describe("FrameworkLoader certtype", () => {
  let env: TestEnvironment;
  let contextManager: ContextManager;
  let loader: FrameworkLoader;
  let pm: PersistenceManager;
  let persistenceHelper: TestPersistenceHelper;

  beforeEach(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [
        "^frameworks/npm-nodejs\\.json$",
        "^applications/npm-nodejs/.*",
        "^shared/.*",
      ],
    });
    const init = env.initPersistence({ enableCache: false });
    pm = init.pm;
    contextManager = init.ctx;
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });
    loader = new FrameworkLoader(
      {
        localPath: env.localDir,
        jsonPath: env.jsonDir,
        schemaPath: env.schemaDir,
      },
      contextManager,
      pm.getPersistence(),
    );
  });

  afterEach(() => {
    env.cleanup();
  });

  it("should pass certtype to generated upload template parameter", async () => {
    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "test-certtype-app",
      name: "Test Certtype Application",
      description: "Application with certtype upload files",
      parameterValues: [
        { id: "hostname", value: "test-certtype" },
        { id: "ostype", value: "alpine" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "test-command" },
        { id: "command_args", value: "--test" },
        { id: "package", value: "test-package" },
        { id: "owned_paths", value: "" },
        { id: "uid", value: "" },
        { id: "group", value: "" },
        { id: "username", value: "testuser" },
        { id: "volumes", value: "certs=certs" },
      ],
      uploadfiles: [
        {
          destination: "certs:server.crt",
          certtype: "server",
          required: false,
          advanced: true,
        },
      ],
    };

    await loader.createApplicationFromFramework(request);

    // Read the generated template
    const templateContent = persistenceHelper.readJsonSync(
      Volume.LocalRoot,
      "applications/test-certtype-app/templates/0-upload-server-crt.json",
    );

    // Find the content parameter (first parameter)
    const contentParam = templateContent.parameters?.find(
      (p: any) => p.id === "upload_server_crt_content",
    );
    expect(contentParam).toBeDefined();
    expect(contentParam.upload).toBe(true);
    expect(contentParam.certtype).toBe("server");
  }, 60000);

  it("should generate upload template without certtype when not set", async () => {
    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "test-no-certtype-app",
      name: "Test No Certtype Application",
      description: "Application without certtype",
      parameterValues: [
        { id: "hostname", value: "test-no-certtype" },
        { id: "ostype", value: "alpine" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "test-command" },
        { id: "command_args", value: "--test" },
        { id: "package", value: "test-package" },
        { id: "owned_paths", value: "" },
        { id: "uid", value: "" },
        { id: "group", value: "" },
        { id: "username", value: "testuser" },
        { id: "volumes", value: "config=conf" },
      ],
      uploadfiles: [
        {
          destination: "config:app.conf",
          required: false,
        },
      ],
    };

    await loader.createApplicationFromFramework(request);

    const templateContent = persistenceHelper.readJsonSync(
      Volume.LocalRoot,
      "applications/test-no-certtype-app/templates/0-upload-app-conf.json",
    );

    const contentParam = templateContent.parameters?.find(
      (p: any) => p.id === "upload_app_conf_content",
    );
    expect(contentParam).toBeDefined();
    expect(contentParam.upload).toBe(true);
    expect(contentParam.certtype).toBeUndefined();
  }, 60000);
});
