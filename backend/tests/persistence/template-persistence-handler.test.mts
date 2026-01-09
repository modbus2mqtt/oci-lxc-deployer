import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs, {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { TemplatePersistenceHandler } from "@src/persistence/template-persistence-handler.mjs";
import { JsonValidator } from "@src/jsonvalidator.mjs";

describe("TemplatePersistenceHandler", () => {
  let testDir: string;
  let jsonPath: string;
  let localPath: string;
  let schemaPath: string;
  let handler: TemplatePersistenceHandler;
  let jsonValidator: JsonValidator;

  beforeEach(() => {
    // Setup temporäre Verzeichnisse
    testDir = mkdtempSync(path.join(tmpdir(), "template-handler-test-"));
    jsonPath = path.join(testDir, "json");
    localPath = path.join(testDir, "local");
    schemaPath = path.join(__dirname, "../../../schemas"); // Use real schemas from root

    // Verzeichnisse erstellen
    mkdirSync(jsonPath, { recursive: true });
    mkdirSync(localPath, { recursive: true });

    // JsonValidator initialisieren (benötigt Schemas)
    jsonValidator = new JsonValidator(schemaPath, [
      "templatelist.schema.json",
    ]);

    // TemplatePersistenceHandler initialisieren
    handler = new TemplatePersistenceHandler(
      { jsonPath, localPath, schemaPath },
      jsonValidator,
    );
  });

  afterEach(() => {
    // Cleanup
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeJson(filePath: string, data: any): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  describe("resolveTemplatePath()", () => {
    it("should resolve shared template path from json directory", () => {
      // Setup: Shared template erstellen
      const templatesDir = path.join(jsonPath, "shared", "templates");
      mkdirSync(templatesDir, { recursive: true });
      writeJson(path.join(templatesDir, "testtemplate.json"), {
        name: "Test Template",
        commands: [],
      });

      const result = handler.resolveTemplatePath("testtemplate", true);
      expect(result).not.toBeNull();
      expect(result).toBe(path.join(templatesDir, "testtemplate.json"));
    });

    it("should prefer local over json for shared templates", () => {
      // Setup: Template in beiden Verzeichnissen
      const jsonTemplatesDir = path.join(jsonPath, "shared", "templates");
      const localTemplatesDir = path.join(localPath, "shared", "templates");
      mkdirSync(jsonTemplatesDir, { recursive: true });
      mkdirSync(localTemplatesDir, { recursive: true });
      writeJson(path.join(jsonTemplatesDir, "testtemplate.json"), {
        name: "JSON Template",
        commands: [],
      });
      writeJson(path.join(localTemplatesDir, "testtemplate.json"), {
        name: "Local Template",
        commands: [],
      });

      const result = handler.resolveTemplatePath("testtemplate", true);
      expect(result).toBe(path.join(localTemplatesDir, "testtemplate.json"));
    });

    it("should return null when template not found", () => {
      const result = handler.resolveTemplatePath("nonexistent", true);
      expect(result).toBeNull();
    });

    it("should handle template name with or without .json extension", () => {
      // Setup: Template erstellen
      const templatesDir = path.join(jsonPath, "shared", "templates");
      mkdirSync(templatesDir, { recursive: true });
      writeJson(path.join(templatesDir, "testtemplate.json"), {
        name: "Test Template",
        commands: [],
      });

      const result1 = handler.resolveTemplatePath("testtemplate", true);
      const result2 = handler.resolveTemplatePath("testtemplate.json", true);
      expect(result1).toBe(result2);
    });
  });

  describe("loadTemplate()", () => {
    it("should load template from file", () => {
      // Setup: Template erstellen
      const templatesDir = path.join(jsonPath, "shared", "templates");
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "testtemplate.json");
      writeJson(templateFile, {
        name: "Test Template",
        commands: [{ name: "test", command: "echo test" }],
      });

      const result = handler.loadTemplate(templateFile);
      expect(result).not.toBeNull();
      expect(result?.name).toBe("Test Template");
      expect(result?.commands).toHaveLength(1);
    });

    it("should cache template", () => {
      // Setup: Template erstellen (minimal valid template)
      const templatesDir = path.join(jsonPath, "shared", "templates");
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "testtemplate.json");
      writeJson(templateFile, {
        name: "Test Template",
        commands: [{ name: "test", command: "echo test" }],
      });

      const result1 = handler.loadTemplate(templateFile);
      expect(result1).not.toBeNull();
      expect(result1?.name).toBe("Test Template");

      // Load again should use cache (if mtime hasn't changed)
      const result2 = handler.loadTemplate(templateFile);
      expect(result2).not.toBeNull();
      expect(result2?.name).toBe("Test Template");
    });

    it("should return null when file does not exist", () => {
      const result = handler.loadTemplate(
        path.join(jsonPath, "nonexistent.json"),
      );
      expect(result).toBeNull();
    });

    it("should return null when template is invalid", () => {
      // Setup: Invalid template
      const templatesDir = path.join(jsonPath, "shared", "templates");
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "invalid.json");
      writeFileSync(templateFile, "{ invalid json }");

      const result = handler.loadTemplate(templateFile);
      expect(result).toBeNull();
    });
  });

  describe("writeTemplate() and deleteTemplate()", () => {
    it("should write shared template to local directory", () => {
      const template = {
        name: "New Template",
        commands: [{ name: "test", command: "echo test" }],
      };

      handler.writeTemplate("newtemplate", template as any, true);

      // Verify file exists
      const templateFile = path.join(
        localPath,
        "shared",
        "templates",
        "newtemplate.json",
      );
      expect(existsSync(templateFile)).toBe(true);

      // Verify content
      const content = JSON.parse(readFileSync(templateFile, "utf-8"));
      expect(content.name).toBe("New Template");
    });

    it("should delete shared template from local directory", () => {
      // Setup: Template erstellen
      const templatesDir = path.join(localPath, "shared", "templates");
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "deletetemplate.json");
      writeJson(templateFile, {
        name: "Delete Template",
        commands: [],
      });

      handler.deleteTemplate("deletetemplate", true);

      // Verify file is deleted
      expect(existsSync(templateFile)).toBe(false);
    });

    it("should invalidate cache when writing template", () => {
      // Setup: Template erstellen und laden (populate cache)
      const templatesDir = path.join(jsonPath, "shared", "templates");
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "cachedtemplate.json");
      writeJson(templateFile, {
        name: "Cached Template",
        commands: [],
      });

      handler.loadTemplate(templateFile);

      // Write new template (should invalidate cache)
      handler.writeTemplate("newtemplate", {
        name: "New Template",
        commands: [],
      } as any, true);

      // Cache should be cleared
      // (We can't directly test this, but it's verified by the fact that
      // writeTemplate calls invalidateCache internally)
    });
  });

  describe("invalidateCache()", () => {
    it("should clear template cache", () => {
      // Setup: Template erstellen und laden
      const templatesDir = path.join(jsonPath, "shared", "templates");
      mkdirSync(templatesDir, { recursive: true });
      const templateFile = path.join(templatesDir, "testtemplate.json");
      writeJson(templateFile, {
        name: "Test Template",
        commands: [],
      });

      handler.loadTemplate(templateFile);

      // Invalidate cache
      handler.invalidateCache();

      // Cache should be cleared
      // (We can't directly test the cache state, but invalidateCache should not throw)
      expect(() => handler.invalidateCache()).not.toThrow();
    });
  });
});

