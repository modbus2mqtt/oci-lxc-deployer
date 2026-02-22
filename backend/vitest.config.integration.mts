import { mergeConfig } from "vitest/config";
import { baseConfig } from "./vitest.config.base.mjs";

/**
 * Vitest configuration for integration tests.
 * These tests make real network requests and need longer timeouts.
 */
export default mergeConfig(baseConfig, {
  test: {
    testTimeout: 120000, // 120 seconds for integration tests (network requests)
    include: ["tests/integration/**/*.test.mts"],
  },
});
