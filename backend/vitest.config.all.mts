import { mergeConfig } from "vitest/config";
import { baseConfig } from "./vitest.config.base.mjs";

/**
 * Vitest configuration for all tests (unit + integration).
 * Use this when you want to run everything together.
 */
export default mergeConfig(baseConfig, {
  test: {
    include: ["tests/**/*.test.mts", "tests/integration/**/*.test.mts"],
    exclude: [
      "tests/template-tests/**",
      "**/node_modules/**",
      "**/.git/**",
    ],
  },
});
