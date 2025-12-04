import { StorageContext } from "@src/storagecontext.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect } from "vitest";
StorageContext.setInstance("local");

describe("JsonValidator", () => {
  const appFile = join(
    __dirname,
    "../json/applications/modbus2mqtt/application.json",
  );
  const sharedTemplate = join(
    __dirname,
    "../json/shared/templates/010-get-latest-os-template.json",
  );
  const appSchema = "application.schema.json";
  const templateSchema = "template.schema.json";

  it("should construct and validate all schemas", () => {
    expect(() => StorageContext.getInstance().getJsonValidator()).not.toThrow();
  });

  it("should validate modbus2mqtt/application.json", () => {
    const validator = StorageContext.getInstance().getJsonValidator();
    expect(() =>
      validator.serializeJsonFileWithSchema(appFile, appSchema),
    ).not.toThrow();
  });

  it("should validate a shared template", () => {
    const validator = StorageContext.getInstance().getJsonValidator();
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
    const validator = StorageContext.getInstance().getJsonValidator();
    let error: any = undefined;
    try {
      validator.serializeJsonFileWithSchema(invalidAppFile, appSchema);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(error.details[0].line).toBe(4);
    expect(Array.isArray(error.details)).toBe(true);
    // The line number should be in the range of the modified line
    expect(error.details.some((d: any) => d.line > 0)).toBe(true);
    // Cleanup
    rmSync(tmp, { recursive: true, force: true });
  });
});
