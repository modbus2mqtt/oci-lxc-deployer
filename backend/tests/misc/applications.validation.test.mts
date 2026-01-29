import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";

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

function findApplicationFiles(root: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...findApplicationFiles(full));
    } else if (entry.isFile() && entry.name === "application.json") {
      results.push(full);
    }
  }
  return results;
}

describe("Application JSON validation", () => {
  it("validates all application.json files against application.schema.json", () => {
    const rootDir = path.join(__dirname, "..");
    const jsonRoot = path.join(rootDir, "json");

    const appFiles: string[] = fs.existsSync(jsonRoot)
      ? findApplicationFiles(jsonRoot)
      : [];

    const validator = PersistenceManager.getInstance().getJsonValidator();
    const schemaKey = "application.schema.json";

    const errors: { file: string; message: string }[] = [];
    for (const filePath of appFiles) {
      try {
        validator.serializeJsonFileWithSchema(filePath, schemaKey);
      } catch (e: any) {
        const msg = e && (e.message || String(e));
        errors.push({ file: path.relative(rootDir, filePath), message: msg });
      }
    }

    if (errors.length > 0) {
      const list = errors.map((e) => `- ${e.file}: ${e.message}`).join("\n");
      throw new Error(
        `Application validation failed for ${errors.length} file(s):\n${list}`,
      );
    }
    expect(errors.length).toBe(0);
  });
});
