import { mergeConfig } from "vitest/config";
import { baseConfig } from "./vitest.config.base.mjs";

/**
 * Default Vitest configuration for unit tests.
 * Excludes integration tests for faster test runs.
 */
export default mergeConfig(baseConfig, {
  test: {
    include: ["tests/**/*.test.mts"],
    exclude: [
      "tests/integration/**",
      "tests/*.test.mts",
      "**/node_modules/**",
      "**/.git/**",
    ],
  },
});
