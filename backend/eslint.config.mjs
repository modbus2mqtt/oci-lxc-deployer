import vitestPlugin from "eslint-plugin-vitest";
import prettierConfig from "eslint-config-prettier";

export default [
  // Ignore build outputs
  {
    ignores: ["dist/**"],
  },
  // Vitest rules for test files
  {
    files: ["tests/**/*.mts"],
    plugins: { vitest: vitestPlugin },
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "warn",
      "vitest/expect-expect": "warn",
      "vitest/no-identical-title": "error",
      // ...additional Vitest rules as needed...
    },
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
  },
  // Prettier configuration for all files
  {
    ...prettierConfig,
  },
  // General TypeScript/ESM rules for the project
  {
    files: ["**/*.ts", "**/*.mts"],
    ignores: ["vitest.config.mts", "vite.config.*", "eslint.config.*"],
    languageOptions: {
      parser: (await import("@typescript-eslint/parser")).default,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.eslint.json",
      },
    },
    plugins: {
      "@typescript-eslint": (await import("@typescript-eslint/eslint-plugin"))
        .default,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      // ...additional TypeScript rules as needed...
    },
  },
];
