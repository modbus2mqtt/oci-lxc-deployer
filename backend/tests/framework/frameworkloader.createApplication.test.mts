import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { ContextManager } from "@src/context-manager.mjs";
import { IPostFrameworkCreateApplicationBody } from "@src/types.mjs";
import { IApplication } from "@src/backend-types.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

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
    const appData = validator.serializeJsonFileWithSchema(
      appJsonPath,
      "application.schema.json",
    ) as IApplication;
    expect(appData.name).toBe("Test Application");
    expect(appData.description).toBe(
      "A test application created from framework",
    );
    expect(appData.extends).toBe("npm-nodejs");
    // New category format: installation is empty object (all templates come from extended application)
    expect(typeof appData.installation).toBe("object");
    expect(appData.installation).not.toBeNull();
    // Empty object means all categories are inherited
    const categories = ["image", "pre_start", "start", "post_start"];
    for (const cat of categories) {
      expect((appData.installation as any)[cat]).toBeUndefined();
    }

    // New 1-file format: properties are directly in application.json
    // Note: For npm-nodejs framework, properties don't have "default: true",
    // so they all go to properties (fixed outputs), not parameters (user-editable)
    expect(appData.properties).toBeDefined();
    expect(Array.isArray(appData.properties)).toBe(true);
    expect(appData.properties!.length).toBeGreaterThan(0);
    // Check that ostype property is present
    const ostypeProperty = appData.properties!.find((p) => p.id === "ostype");
    expect(ostypeProperty).toBeDefined();
    expect(ostypeProperty!.value).toBe("alpine");
    // Check that hostname property is present
    const hostnameProperty = appData.properties!.find(
      (p) => p.id === "hostname",
    );
    expect(hostnameProperty).toBeDefined();
    expect(hostnameProperty!.value).toBe("test-app");

    // New 1-file format: no separate template file is created
    expect(() =>
      persistenceHelper.readTextSync(
        Volume.LocalRoot,
        "applications/test-app/templates/test-app-parameters.json",
      ),
    ).toThrow(); // File should NOT exist
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

    await expect(
      loader.createApplicationFromFramework(request),
    ).rejects.toThrow("already exists at");
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

    await expect(
      loader.createApplicationFromFramework(request),
    ).rejects.toThrow();
  });
});
