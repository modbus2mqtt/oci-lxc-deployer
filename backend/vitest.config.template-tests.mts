import { mergeConfig } from "vitest/config";
import { baseConfig } from "./vitest.config.base.mjs";

/**
 * Vitest configuration for template integration tests.
 * These tests execute real scripts on a nested Proxmox VM via SSH.
 * They are skipped automatically when the test host is not reachable.
 */
export default mergeConfig(baseConfig, {
  test: {
    testTimeout: 120000, // 120 seconds (container operations can be slow)
    include: ["tests/template-tests/**/*.test.mts"],
    globalSetup: ["tests/template-tests/helper/global-setup.mts"],
  },
});
