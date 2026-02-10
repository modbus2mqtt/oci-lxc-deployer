import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

let env: TestEnvironment;
let persistenceHelper: TestPersistenceHelper;
let appFile: string;
let sharedTemplate: string;

beforeAll(() => {
  env = createTestEnvironment(import.meta.url, {
    // Copy only required files into env.jsonDir
    jsonIncludePatterns: [
      "^applications/oci-image/application\\.json$",
      "^shared/templates/image/011-host-get-oci-image\\.json$",
    ],
    // Schemas are stable and are read from repo directly (default)
  });
  env.initPersistence();
  persistenceHelper = new TestPersistenceHelper({
    repoRoot: env.repoRoot,
    localRoot: env.localDir,
    jsonRoot: env.jsonDir,
    schemasRoot: env.schemaDir,
  });
  appFile = persistenceHelper.resolve(
    Volume.JsonApplications,
    "oci-image/application.json",
  );
  sharedTemplate = persistenceHelper.resolve(
    Volume.JsonSharedTemplates,
    "image/011-host-get-oci-image.json",
  );
});

afterAll(() => {
  try {
    env.cleanup();
  } catch {
    // ignore cleanup errors
  }
});

describe("JsonValidator", () => {
  const appSchema = "application.schema.json";
  const templateSchema = "template.schema.json";

  it("should construct and validate all schemas", () => {
    expect(() =>
      PersistenceManager.getInstance().getJsonValidator(),
    ).not.toThrow();
  });

  it("should validate oci-image/application.json", () => {
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
    // Copy and modify application.json in a temp file
    const invalidAppFile = persistenceHelper.resolve(
      Volume.LocalRoot,
      "jsonvalidator/invalid-application.json",
    );
    const original = persistenceHelper.readTextSync(
      Volume.JsonApplications,
      "oci-image/application.json",
    );
    // Intentionally insert an error (e.g. invalid value for a known property)
    // Replace "name" with an invalid type (number instead of string)
    const broken = original.replace(
      /"name"\s*:\s*"[^"]*"/,
      '"name": 12345',
    );
    persistenceHelper.writeTextSync(
      Volume.LocalRoot,
      "jsonvalidator/invalid-application.json",
      broken,
    );
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
  });
});
