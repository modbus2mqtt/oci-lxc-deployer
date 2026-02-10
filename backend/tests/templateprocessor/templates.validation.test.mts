import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "../helper/test-persistence-helper.mjs";

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

const persistence = new TestPersistenceHelper();

describe("Template JSON validation", () => {
  it("validates all templates against template.schema.json", () => {
    const rootDir = env.repoRoot;
    const jsonFiles = persistence
      .listSync(Volume.JsonRoot)
      .filter(
        (p) =>
          p.endsWith(".json") && p.includes(`${path.sep}templates${path.sep}`),
      )
      .map((p) => persistence.resolve(Volume.JsonRoot, p));
    const localJsonFiles = persistence
      .listSync(Volume.LocalRoot, "json")
      .filter(
        (p) =>
          p.endsWith(".json") && p.includes(`${path.sep}templates${path.sep}`),
      )
      .map((p) => persistence.resolve(Volume.LocalRoot, path.join("json", p)));

    const templateFiles = [...jsonFiles, ...localJsonFiles];

    const validator = PersistenceManager.getInstance().getJsonValidator();
    const schemaKey = "template.schema.json";

    const errors: { file: string; message: string }[] = [];
    for (const filePath of templateFiles) {
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
        `Template validation failed for ${errors.length} file(s):\n${list}`,
      );
    }
    expect(errors.length).toBe(0);
  });
});
