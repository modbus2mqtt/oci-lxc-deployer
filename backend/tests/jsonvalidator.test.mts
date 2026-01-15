import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestEnvironment, type TestEnvironment } from "./test-environment.mjs";

let env: TestEnvironment;

beforeAll(() => {
  env = createTestEnvironment(import.meta.url, {
    // This test validates files by absolute path; no json copying required
    jsonIncludePatterns: [],
    // Schemas are stable and are read from repo directly (default)
  });
  env.initPersistence();
});

afterAll(() => {
  try {
    env.cleanup();
  } catch {
    // ignore cleanup errors
  }
});

describe("JsonValidator", () => {
  const appFile = join(
    __dirname,
    "../../json/applications/modbus2mqtt/application.json",
  );
  const sharedTemplate = join(
    __dirname,
    "../../json/shared/templates/010-get-latest-os-template.json",
  );
  const appSchema = "application.schema.json";
  const templateSchema = "template.schema.json";

  it("should construct and validate all schemas", () => {
    expect(() => PersistenceManager.getInstance().getJsonValidator()).not.toThrow();
  });

  it("should validate modbus2mqtt/application.json", () => {
    const validator = PersistenceManager.getInstance().getJsonValidator();
    expect(() =>
      validator.serializeJsonFileWithSchema(appFile, appSchema),
    ).not.toThrow();
  });

  it("should validate a shared template", () => {
    const validator = PersistenceManager.getInstance().getJsonValidator();
    expect(() =>
      validator.serializeJsonFileWithSchema(sharedTemplate, templateSchema),
    ).not.toThrow();
  });

  it("should throw and report line number for invalid application.json", () => {
    // Copy and modify application.json in a tmpdir
    const tmp = mkdtempSync(join(tmpdir(), "jsonvalidator-test-"));
    const invalidAppFile = join(tmp, "application.json");
    const original = require("fs").readFileSync(appFile, "utf-8");
    // Intentionally insert an error (e.g. object instead of array for installation)
    const broken = original.replace(
      /"installation"\s*:\s*\[[^\]]*\]/,
      '"installation": { "foo": 1 }',
    );
    writeFileSync(invalidAppFile, broken);
    const validator = PersistenceManager.getInstance().getJsonValidator();
    let error: any = undefined;
    try {
      validator.serializeJsonFileWithSchema(invalidAppFile, appSchema);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(Array.isArray(error.details)).toBe(true);
    // The line number should be in the range of the modified line
    expect(error.details.some((d: any) => d.line > 0)).toBe(true);
    // Cleanup
    rmSync(tmp, { recursive: true, force: true });
  });
});
