import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { VEConfigurationError, IVEContext } from "@src/backend-types.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import type { IPostFrameworkCreateApplicationBody } from "@src/types.mjs";
import path from "node:path";

describe("FrameworkLoader - docker-compose", () => {
  let env: TestEnvironment;
  let loader: FrameworkLoader;
  let contextManager: ReturnType<TestEnvironment["initPersistence"]>["ctx"];
  let pm: ReturnType<TestEnvironment["initPersistence"]>["pm"];

  beforeAll(() => {
    // Create test environment with temporary directories
    // localDir will be a unique temporary directory for this test
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [
        "^frameworks/docker-compose\\.json$",
        "^applications/docker-compose/.*",
        "^shared/.*",
      ],
    });
    
    // Verify that localDir is a temporary directory (not the repo's local directory)
    expect(env.localDir).not.toContain("examples");
    expect(env.localDir).toContain("oci-lxc-deployer-test-");
    
    const init = env.initPersistence({ enableCache: false });
    pm = init.pm;
    contextManager = init.ctx;
    loader = new FrameworkLoader(
      {
        localPath: env.localDir, // Temporary directory for local applications
        jsonPath: env.jsonDir,
        schemaPath: env.schemaDir,
      },
      contextManager,
      pm.getPersistence(),
    );
  });

  afterAll(() => {
    // Cleanup temporary directories
    env.cleanup();
  });

  it(
    "should set hostname as optional and compose_project as optional for docker-compose framework",
    async () => {
      // Load framework to ensure it's valid (result not used directly)
      loader.readFrameworkJson("docker-compose", {
        error: new VEConfigurationError("", "docker-compose"),
      });
      const veContext: IVEContext = {
        host: "validation-dummy",
        getStorageContext: () => contextManager as any,
        getKey: () => "ve_validation",
      };

      // getParameters can be slow due to:
      // - Template processing (loadApplication)
      // - Script validation (may attempt SSH connections with retries)
      // - File system operations
      const parameters = await loader.getParameters(
        "docker-compose",
        "installation",
        veContext,
      );

      // Find hostname and compose_project parameters
      const hostnameParam = parameters.find((p) => p.id === "hostname");
      const composeProjectParam = parameters.find((p) => p.id === "compose_project");

      // Verify hostname exists and is optional (Application ID can be used as default)
      expect(hostnameParam).toBeDefined();
      expect(hostnameParam?.required).toBe(false);
      expect(hostnameParam?.id).toBe("hostname");

      // Verify compose_project exists and is optional
      expect(composeProjectParam).toBeDefined();
      expect(composeProjectParam?.required).toBe(false);
      expect(composeProjectParam?.id).toBe("compose_project");

      // Verify that other parameters maintain their required status
      // compose_file should be required (from base application)
      const composeFileParam = parameters.find((p) => p.id === "compose_file");
      expect(composeFileParam).toBeDefined();
      expect(composeFileParam?.required).toBe(true);

      // env_file should be optional (from base application)
      const envFileParam = parameters.find((p) => p.id === "env_file");
      expect(envFileParam).toBeDefined();
      expect(envFileParam?.required).toBe(false);

      // Verify that advanced flag is removed for all parameters
      for (const param of parameters) {
        expect((param as any).advanced).toBeUndefined();
      }
    },
    60000, // 60 second timeout - getParameters can be slow due to template processing and SSH retries
  );

  it(
    "should use Application ID as default for hostname when creating application without hostname",
    async () => {
      const request: IPostFrameworkCreateApplicationBody = {
        frameworkId: "docker-compose",
        applicationId: "test-app-123",
        name: "Test Docker Compose App",
        description: "Test app",
        parameterValues: [
          {
            id: "compose_file",
            value: "dGVzdDogdmFsdWU=", // base64 encoded test yaml
          },
        ],
      };

      const applicationId = await loader.createApplicationFromFramework(request);
      expect(applicationId).toBe("test-app-123");

      // New 1-file format: parameters and properties are in application.json directly
      const appJsonPath = path.join(
        env.localDir,
        "applications",
        "test-app-123",
        "application.json",
      );
      const appJson = JSON.parse(require("fs").readFileSync(appJsonPath, "utf-8"));

      // Find hostname parameter in application.json
      const hostnameParam = appJson.parameters?.find((p: any) => p.id === "hostname");
      expect(hostnameParam).toBeDefined();
      expect(hostnameParam?.required).toBe(false);
      expect(hostnameParam?.default).toBe("test-app-123"); // Application ID should be default

      // Find hostname in properties (should be set to Application ID)
      const hostnameProperty = appJson.properties?.find(
        (p: any) => p.id === "hostname",
      );
      expect(hostnameProperty).toBeDefined();
      expect(hostnameProperty?.value).toBe("test-app-123"); // Application ID should be value

      // Verify no separate template file is created
      const templatePath = path.join(
        env.localDir,
        "applications",
        "test-app-123",
        "templates",
        "test-app-123-parameters.json",
      );
      expect(require("fs").existsSync(templatePath)).toBe(false);
    },
    60000,
  );
});
