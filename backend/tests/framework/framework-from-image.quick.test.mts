import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { IVEContext } from "@src/backend-types.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { FrameworkFromImage } from "@src/framework-from-image.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";

/**
 * Quick integration test for FrameworkFromImage.getAnnotationsFromImage.
 * 
 * This test verifies that the script integration works correctly by:
 * - Testing with a non-existent image (should throw "not found" error quickly)
 * - Testing with an existing image (should return annotations after fast existence check)
 * 
 * The script automatically checks image existence first (fast --raw check),
 * then performs full inspection if the image exists.
 * 
 * This test is fast (< 15 seconds) and can run with regular unit tests.
 * It uses ExecutionMode.TEST to run locally (requires skopeo to be installed).
 */
describe("FrameworkFromImage - Quick Integration Test", () => {
  const localhostVEContext: IVEContext = {
    host: "localhost",
    port: 22,
    getKey: () => "ve_localhost",
    getStorageContext: () => null,
  } as unknown as IVEContext;

  // Check if skopeo is available (synchronous check)
  const skopeoAvailable = (() => {
    try {
      const { execSync } = require("child_process");
      execSync("which skopeo", { stdio: "ignore" });
      execSync("skopeo --version", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  let env: TestEnvironment;

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: ["^shared/scripts/get-oci-image-annotations\\.py$"],
    });
    env.initPersistence({ enableCache: false });
  });

  afterAll(() => {
    env.cleanup();
  });

  (skopeoAvailable ? it : it.skip)(
    "should quickly return 404 for non-existent image",
    { timeout: 5000 }, // 5 second timeout for quick check
    async () => {
      await expect(
        FrameworkFromImage.getAnnotationsFromImage(
          localhostVEContext,
          "this-image-definitely-does-not-exist-12345",
          "latest",
          ExecutionMode.TEST,
        ),
      ).rejects.toThrow("not found");
    },
  );

  (skopeoAvailable ? it : it.skip)(
    "should successfully get annotations for existing image (alpine:latest)",
    { timeout: 15000 }, // 15 second timeout (includes fast check + full inspection)
    async () => {
      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "alpine",
        "latest",
        ExecutionMode.TEST,
      );

      // Alpine may not have annotations, but should not throw "not found"
      expect(annotations).toBeDefined();
      expect(typeof annotations).toBe("object");
    },
  );
});

