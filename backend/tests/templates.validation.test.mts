import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { createTestEnvironment, type TestEnvironment } from "./test-environment.mjs";

let env: TestEnvironment;

beforeAll(() => {
  env = createTestEnvironment(import.meta.url, {
    jsonIncludePatterns: [],
  });
  env.initPersistence();
});

afterAll(() => {
  try {
    env.cleanup();
  } catch {
    // ignore
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

    const validator = PersistenceManager.getInstance().getJsonValidator();
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
