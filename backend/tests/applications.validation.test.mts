import { describe, it, expect } from "vitest";
import path from "path";
import fs from "fs";
import { StorageContext } from "@src/storagecontext.mjs";

// Initialize StorageContext (schemas + paths) using default 'local'
StorageContext.setInstance("local");

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

    const validator = StorageContext.getInstance().getJsonValidator();
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
      const list = errors
        .map((e) => `- ${e.file}: ${e.message}`)
        .join("\n");
      throw new Error(`Application validation failed for ${errors.length} file(s):\n${list}`);
    }
    expect(errors.length).toBe(0);
  });
});
