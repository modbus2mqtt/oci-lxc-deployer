import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ScriptValidator } from "@src/scriptvalidator.mjs";
import { JsonError } from "@src/jsonvalidator.mjs";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(path.join(os.tmpdir(), "scriptvalidator-library-test-"));
});

afterAll(() => {
  try {
    if (testDir && fs.existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
});

describe("ScriptValidator - Library validation", () => {
  it("should error when library contains template variables", () => {
    const libraryPath = path.join(testDir, "library-with-vars.sh");
    fs.writeFileSync(libraryPath, "function test() { echo '{{ variable }}'; }");

    const validator = new ScriptValidator();
    const errors: JsonError[] = [];
    const scriptPathes = [testDir];

    validator.validateLibrary("library-with-vars.sh", errors, "test", undefined, scriptPathes);

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("contains template variables");
    expect(errors[0].message).toContain("variable");
  });

  it("should error when library file not found", () => {
    const validator = new ScriptValidator();
    const errors: JsonError[] = [];
    const scriptPathes = [testDir];

    validator.validateLibrary("non-existent-library.sh", errors, "test", undefined, scriptPathes);

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("Library file not found");
    expect(errors[0].message).toContain("non-existent-library.sh");
  });

  it("should pass validation when library contains no template variables", () => {
    const libraryPath = path.join(testDir, "valid-library.sh");
    fs.writeFileSync(libraryPath, "function test() { echo 'no variables'; }");

    const validator = new ScriptValidator();
    const errors: JsonError[] = [];
    const scriptPathes = [testDir];

    validator.validateLibrary("valid-library.sh", errors, "test", undefined, scriptPathes);

    expect(errors.length).toBe(0);
  });

  it("should error when scriptPathes not provided", () => {
    const validator = new ScriptValidator();
    const errors: JsonError[] = [];

    validator.validateLibrary("library.sh", errors, "test", undefined, undefined);

    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("scriptPathes not provided");
  });

  it("should error when library file cannot be read", () => {
    const libraryPath = path.join(testDir, "unreadable-library.sh");
    fs.writeFileSync(libraryPath, "function test() { echo 'test'; }");
    // Make file unreadable (on Unix systems)
    if (process.platform !== "win32") {
      fs.chmodSync(libraryPath, 0o000);
    }

    const validator = new ScriptValidator();
    const errors: JsonError[] = [];
    const scriptPathes = [testDir];

    validator.validateLibrary("unreadable-library.sh", errors, "test", undefined, scriptPathes);

    // On Windows, file might still be readable, so we check if error occurred
    if (process.platform !== "win32") {
      expect(errors.length).toBeGreaterThan(0);
    }

    // Restore permissions for cleanup
    if (process.platform !== "win32") {
      fs.chmodSync(libraryPath, 0o644);
    }
  });
});

