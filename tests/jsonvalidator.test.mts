import { JsonValidator } from "../src/jsonvalidator.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect } from "vitest";

describe("JsonValidator", () => {
  const schemasDir = join(__dirname, "../schemas");
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
    expect(() => JsonValidator.getInstance(schemasDir)).not.toThrow();
  });

  it("should validate modbus2mqtt/application.json", () => {
    const validator = JsonValidator.getInstance(schemasDir);
    expect(() =>
      validator.serializeJsonFileWithSchema(appFile, appSchema),
    ).not.toThrow();
  });

  it("should validate a shared template", () => {
    const validator = JsonValidator.getInstance(schemasDir);
    expect(() =>
      validator.serializeJsonFileWithSchema(sharedTemplate, templateSchema),
    ).not.toThrow();
  });

  it("should throw and report line number for invalid application.json", () => {
    // Copy and modify application.json in a tmpdir
    const tmp = mkdtempSync(join(tmpdir(), "jsonvalidator-test-"));
    const invalidAppFile = join(tmp, "application.json");
    const original = require("fs").readFileSync(appFile, "utf-8");
    // Füge absichtlich einen Fehler ein (z.B. Objekt statt Array für installation)
    const broken = original.replace(
      /"installation"\s*:\s*\[[^\]]*\]/,
      '"installation": { "foo": 1 }',
    );
    writeFileSync(invalidAppFile, broken);
    const validator = JsonValidator.getInstance(schemasDir);
    let error: any = undefined;
    try {
      validator.serializeJsonFileWithSchema(invalidAppFile, appSchema);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(error.message).toMatch(/Validation failed/);
    expect(error.errorLines).toBeDefined();
    expect(Array.isArray(error.errorLines)).toBe(true);
    // Die Zeilennummer sollte im Bereich der modifizierten Zeile liegen
    expect(error.errorLines.some((l: number) => l > 0)).toBe(true);
    // Aufräumen
    rmSync(tmp, { recursive: true, force: true });
  });
});
