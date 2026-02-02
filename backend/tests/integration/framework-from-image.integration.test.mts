import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { IVEContext } from "@src/backend-types.mjs";
import { execSync } from "child_process";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { FrameworkFromImage } from "@src/framework-from-image.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

// Check if skopeo is available (synchronously at module load time)
let skopeoAvailable = false;
try {
  execSync("which skopeo", { stdio: "ignore" });
  skopeoAvailable = true;
} catch {
  skopeoAvailable = false;
}

describe("FrameworkFromImage - Integration Tests", () => {
  const localhostVEContext = {
    host: "localhost",
    port: 22,
    getKey: () => "ve_localhost",
    getStorageContext: () => {},
  } as  IVEContext;
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;

  describe("getAnnotationsFromImage - ungemockt (localhost)", () => {
    // Only run if skopeo is available
    const testIfSkopeo = skopeoAvailable ? it : it.skip;

    beforeAll(() => {
      env = createTestEnvironment(import.meta.url, {
        jsonIncludePatterns: ["^shared/scripts/get-oci-image-annotations\\.py$"],
      });
      persistenceHelper = new TestPersistenceHelper({
        repoRoot: env.repoRoot,
        localRoot: env.localDir,
        jsonRoot: env.jsonDir,
        schemasRoot: env.schemaDir,
      });
      env.initPersistence({ enableCache: false });
    });

    afterAll(() => {
      env.cleanup();
    });

    testIfSkopeo("should extract annotations from home-assistant image (GitHub Container Registry)", async () => {
      // Check if script exists
      const scriptPath = persistenceHelper.resolve(
        Volume.JsonSharedScripts,
        "get-oci-image-annotations.py",
      );
      try {
        persistenceHelper.readTextSync(
          Volume.JsonSharedScripts,
          "get-oci-image-annotations.py",
        );
      } catch {
        throw new Error(`Script not found: ${scriptPath}`);
      }

      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "ghcr.io/home-assistant/home-assistant",
        "latest",
        ExecutionMode.TEST,
      );

      // Home Assistant should have at least some annotations
      // Check that at least one annotation is defined
      const hasAnnotation =
        annotations.url !== undefined ||
        annotations.documentation !== undefined ||
        annotations.source !== undefined ||
        annotations.vendor !== undefined ||
        annotations.description !== undefined;

      expect(hasAnnotation).toBe(true);

      // If source is defined, it should be a valid URL
      if (annotations.source) {
        expect(annotations.source).toMatch(/^https?:\/\//);
      }
    }, 60000); // 60 second timeout for network requests

    testIfSkopeo("should extract annotations from mariadb image (Docker Hub)", async () => {
      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "mariadb",
        "latest",
        ExecutionMode.TEST,
      );

      // MariaDB should have at least some annotations
      const hasAnnotation =
        annotations.url !== undefined ||
        annotations.documentation !== undefined ||
        annotations.source !== undefined ||
        annotations.vendor !== undefined ||
        annotations.description !== undefined;

      expect(hasAnnotation).toBe(true);
    }, 60000);

    testIfSkopeo("should extract annotations from ghcr.io image (GitHub Container Registry)", async () => {
      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "ghcr.io/home-assistant/home-assistant",
        "latest",
        ExecutionMode.TEST,
      );

      // GitHub images should have at least source annotation
      const hasAnnotation =
        annotations.url !== undefined ||
        annotations.documentation !== undefined ||
        annotations.source !== undefined ||
        annotations.vendor !== undefined ||
        annotations.description !== undefined;

      expect(hasAnnotation).toBe(true);

      // GitHub images typically have source pointing to GitHub
      if (annotations.source) {
        expect(annotations.source).toMatch(/github\.com/);
      }

      // Home Assistant should have specific annotations
      expect(annotations.url).toBe("https://www.home-assistant.io/");
      expect(annotations.documentation).toBe("https://www.home-assistant.io/docs/");
      expect(annotations.source).toBe("https://github.com/home-assistant/core");
    }, 60000);

    testIfSkopeo("should extract annotations from docker.io image (explicit Docker Hub)", async () => {
      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "nodered/node-red",
        "latest",
        ExecutionMode.TEST,
      );

      // Node-RED should have at least some annotations
      const hasAnnotation =
        annotations.url !== undefined ||
        annotations.documentation !== undefined ||
        annotations.source !== undefined ||
        annotations.vendor !== undefined ||
        annotations.description !== undefined;

      expect(hasAnnotation).toBe(true);
    }, 60000);
  });
});

