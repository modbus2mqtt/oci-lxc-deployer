import vitestPlugin from "eslint-plugin-vitest";
import prettierConfig from "eslint-config-prettier";

export default [
  // Vitest-Regeln für Testdateien
  {
    files: ["tests/**/*.mts"],
    plugins: { vitest: vitestPlugin },
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "warn",
      "vitest/expect-expect": "warn",
      "vitest/no-identical-title": "error",
      // ...weitere Vitest-Regeln nach Bedarf...
    },
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
  },
  // Prettier-Konfiguration für alle Dateien
  {
    ...prettierConfig,
  },
  // Allgemeine TypeScript/ESM-Regeln für das Projekt
  {
    files: ["**/*.ts", "**/*.mts"],
    ignores: ["vitest.config.mts", "vite.config.*", "eslint.config.*"],
    languageOptions: {
      parser: (await import("@typescript-eslint/parser")).default,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": (await import("@typescript-eslint/eslint-plugin"))
        .default,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      // ...weitere TypeScript-Regeln nach Bedarf...
    },
  },
];
