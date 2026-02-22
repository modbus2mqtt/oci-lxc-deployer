import path from "path";
import { defineConfig } from "vitest/config";

/**
 * Base Vitest configuration shared by all test configs.
 * This reduces code duplication across vitest.config.*.mts files.
 */
export const baseConfig = defineConfig({
  resolve: {
    alias: {
      "@src": path.resolve(__dirname, "src"),
      "@tests": path.resolve(__dirname, "tests"),
    },
  },
  esbuild: {
    sourcemap: "inline",
  },
  test: {
    environment: "node",
    globals: true,
    testTimeout: 60000, // 60 seconds default timeout
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
