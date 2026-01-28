import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { ContextManager } from "@src/context-manager.mjs";
import { IPostFrameworkCreateApplicationBody } from "@src/types.mjs";
import { IApplication } from "@src/backend-types.mjs";
import { ITemplate } from "@src/types.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

describe("FrameworkLoader.createApplicationFromFramework", () => {
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

  it("creates a valid application from framework", async () => {
    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "test-app",
      name: "Test Application",
      description: "A test application created from framework",
      parameterValues: [
        { id: "hostname", value: "test-app" },
        { id: "ostype", value: "alpine" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "test-command" },
        { id: "command_args", value: "--test" },
        { id: "package", value: "test-package" },
        { id: "owned_paths", value: "" },
        { id: "uid", value: "" },
        { id: "group", value: "" },
        { id: "username", value: "testuser" },
        { id: "volumes", value: "data=test" },
      ],
    };

    const applicationId = await loader.createApplicationFromFramework(request);
    expect(applicationId).toBe("test-app");

    // Verify application.json exists and is valid
    const appJsonPath = persistenceHelper.resolve(
      Volume.LocalRoot,
      "applications/test-app/application.json",
    );
    expect(() =>
      persistenceHelper.readTextSync(
        Volume.LocalRoot,
        "applications/test-app/application.json",
      ),
    ).not.toThrow();

    const validator = pm.getJsonValidator();
    // Read and validate the application.json file
    // Note: The file should NOT contain 'id' - it's added when reading via persistence
    const appDataRaw = persistenceHelper.readJsonSync(
      Volume.LocalRoot,
      "applications/test-app/application.json",
    ) as any;
    // Verify that 'id' is not in the file
    expect(appDataRaw).not.toHaveProperty("id");
    const appData = validator.serializeJsonFileWithSchema(appJsonPath, "application.schema.json") as IApplication;
    expect(appData.name).toBe("Test Application");
    expect(appData.description).toBe("A test application created from framework");
    expect(appData.extends).toBe("npm-nodejs");
    expect(Array.isArray(appData.installation)).toBe(true);
    // The first template should be derived from application-id
    // It may be a string or an object with {name, before}
    const firstTemplate = appData.installation?.[0];
    if (typeof firstTemplate === "string") {
      expect(firstTemplate).toBe("test-app-parameters.json");
    } else if (firstTemplate && typeof firstTemplate === "object") {
      expect((firstTemplate as any).name).toBe("test-app-parameters.json");
    } else {
      throw new Error(`Expected first template to be string or object, got ${typeof firstTemplate}`);
    }

    // Verify parameters template exists and is valid
    const setParamsPath = persistenceHelper.resolve(
      Volume.LocalRoot,
      "applications/test-app/templates/test-app-parameters.json",
    );
    expect(() =>
      persistenceHelper.readTextSync(
        Volume.LocalRoot,
        "applications/test-app/templates/test-app-parameters.json",
      ),
    ).not.toThrow();

    const templateData = validator.serializeJsonFileWithSchema(setParamsPath, "template.schema.json") as ITemplate;
    expect(templateData.name).toBe("Set Parameters");
    expect(Array.isArray(templateData.commands)).toBe(true);
    expect(templateData.commands.length).toBeGreaterThan(0);
  });

  it("throws error if application already exists in localPath", async () => {
    // Create existing application directory
    persistenceHelper.writeJsonSync(
      Volume.LocalRoot,
      "applications/existing-app/application.json",
      { name: "Existing" },
    );

    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "existing-app",
      name: "Test Application",
      description: "A test application",
      parameterValues: [],
    };

    await expect(loader.createApplicationFromFramework(request)).rejects.toThrow(
      "already exists at",
    );
  });

  it("allows creating application even if it exists in jsonPath (only localPath is checked)", async () => {
    // Create application in temp json directory
    // Note: The frameworkloader only checks localPath, not jsonPath
    // This allows creating local applications even if the same ID exists in json directory
    persistenceHelper.writeJsonSync(
      Volume.JsonApplications,
      "existing-json-app/application.json",
      { name: "Existing JSON App" },
    );

    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "existing-json-app",
      name: "Test Application",
      description: "A test application",
      parameterValues: [
        { id: "hostname", value: "existing-json-app" },
        { id: "ostype", value: "alpine" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "test-command" },
        { id: "command_args", value: "--test" },
        { id: "package", value: "test-package" },
        { id: "owned_paths", value: "" },
        { id: "uid", value: "" },
        { id: "group", value: "" },
        { id: "username", value: "testuser" },
        { id: "volumes", value: "data=test" },
      ],
    };

    // Should succeed because jsonPath is not checked, only localPath
    const applicationId = await loader.createApplicationFromFramework(request);
    expect(applicationId).toBe("existing-json-app");
    
    // Verify it was created in localPath
    expect(() =>
      persistenceHelper.readTextSync(
        Volume.LocalRoot,
        "applications/existing-json-app/application.json",
      ),
    ).not.toThrow();
  });

  it("throws error for invalid framework", async () => {
    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "non-existent-framework",
      applicationId: "test-app-invalid",
      name: "Test Application",
      description: "A test application",
      parameterValues: [],
    };

    await expect(loader.createApplicationFromFramework(request)).rejects.toThrow();
  });
});

