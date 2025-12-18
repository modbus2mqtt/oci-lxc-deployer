import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { StorageContext } from "@src/storagecontext.mjs";

let testDir: string;
let secretFilePath: string;

beforeAll(() => {
  // Create a temporary directory for the test
  testDir = mkdtempSync(path.join(tmpdir(), "templates-validation-test-"));
  secretFilePath = path.join(testDir, "secret.txt");
  
  // Create a valid storagecontext.json file
  const storageContextPath = path.join(testDir, "storagecontext.json");
  fs.writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

  // Ensure StorageContext is initialized (schemas + paths)
  StorageContext.setInstance(testDir, secretFilePath);
});

afterAll(() => {
  // Cleanup test directory
  try {
    if (fs.existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  } catch (e: any) {
    // Ignore cleanup errors
  }
});

function findTemplateDirs(root: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "templates") {
        results.push(full);
      } else {
        results.push(...findTemplateDirs(full));
      }
    }
  }
  return results;
}

describe("Template JSON validation", () => {
  it("validates all templates against template.schema.json", () => {
    const rootDir = path.join(__dirname, "..");
    const jsonRoot = path.join(rootDir, "json");
    const localJsonRoot = path.join(rootDir, "local", "json");

    const templateDirs = [jsonRoot, localJsonRoot]
      .filter((p) => fs.existsSync(p))
      .flatMap((p) => findTemplateDirs(p));

    const validator = StorageContext.getInstance().getJsonValidator();
    const schemaKey = "template.schema.json";

    const errors: { file: string; message: string }[] = [];
    for (const dir of templateDirs) {
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          validator.serializeJsonFileWithSchema(filePath, schemaKey);
        } catch (e: any) {
          const msg = e && (e.message || String(e));
          errors.push({ file: path.relative(rootDir, filePath), message: msg });
        }
      }
    }

    if (errors.length > 0) {
      const list = errors.map((e) => `- ${e.file}: ${e.message}`).join("\n");
      throw new Error(
        `Template validation failed for ${errors.length} file(s):\n${list}`,
      );
    }
    expect(errors.length).toBe(0);
  });
});
