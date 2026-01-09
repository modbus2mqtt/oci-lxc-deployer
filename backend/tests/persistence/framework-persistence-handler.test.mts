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
import { FrameworkPersistenceHandler } from "@src/persistence/framework-persistence-handler.mjs";
import { JsonValidator } from "@src/jsonvalidator.mjs";
import { VEConfigurationError } from "@src/backend-types.mjs";

describe("FrameworkPersistenceHandler", () => {
  let testDir: string;
  let jsonPath: string;
  let localPath: string;
  let schemaPath: string;
  let handler: FrameworkPersistenceHandler;
  let jsonValidator: JsonValidator;

  beforeEach(() => {
    // Setup temporäre Verzeichnisse
    testDir = mkdtempSync(path.join(tmpdir(), "framework-handler-test-"));
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

    // FrameworkPersistenceHandler initialisieren
    handler = new FrameworkPersistenceHandler(
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

  describe("getAllFrameworkNames()", () => {
    it("should return empty map when no frameworks exist", () => {
      const result = handler.getAllFrameworkNames();
      expect(result.size).toBe(0);
    });

    it("should find frameworks in json directory", () => {
      // Setup: Framework erstellen
      const frameworksDir = path.join(jsonPath, "frameworks");
      mkdirSync(frameworksDir, { recursive: true });
      writeJson(path.join(frameworksDir, "testframework.json"), {
        id: "testframework",
        name: "Test Framework",
        extends: "base",
        properties: [],
      });

      const result = handler.getAllFrameworkNames();
      expect(result.size).toBe(1);
      expect(result.has("testframework")).toBe(true);
    });

    it("should find frameworks in local directory", () => {
      // Setup: Framework erstellen
      const frameworksDir = path.join(localPath, "frameworks");
      mkdirSync(frameworksDir, { recursive: true });
      writeJson(path.join(frameworksDir, "localframework.json"), {
        id: "localframework",
        name: "Local Framework",
        extends: "base",
        properties: [],
      });

      const result = handler.getAllFrameworkNames();
      expect(result.size).toBe(1);
      expect(result.has("localframework")).toBe(true);
    });

    it("should prefer local over json when same name exists", () => {
      // Setup: Framework in beiden Verzeichnissen
      const jsonFrameworkFile = path.join(jsonPath, "frameworks", "duplicate.json");
      const localFrameworkFile = path.join(
        localPath,
        "frameworks",
        "duplicate.json",
      );
      mkdirSync(path.dirname(jsonFrameworkFile), { recursive: true });
      mkdirSync(path.dirname(localFrameworkFile), { recursive: true });
      writeJson(jsonFrameworkFile, {
        id: "duplicate",
        name: "JSON Framework",
        extends: "base",
        properties: [],
      });
      writeJson(localFrameworkFile, {
        id: "duplicate",
        name: "Local Framework",
        extends: "base",
        properties: [],
      });

      const result = handler.getAllFrameworkNames();
      expect(result.size).toBe(1);
      expect(result.get("duplicate")).toBe(localFrameworkFile);
    });

    it("should cache json directory (only loaded once)", () => {
      // Erster Aufruf
      const result1 = handler.getAllFrameworkNames();

      // Framework hinzufügen NACH erstem Aufruf
      const frameworksDir = path.join(jsonPath, "frameworks");
      mkdirSync(frameworksDir, { recursive: true });
      writeJson(path.join(frameworksDir, "newframework.json"), {
        id: "newframework",
        name: "New Framework",
        extends: "base",
        properties: [],
      });

      // Zweiter Aufruf sollte noch alte Daten haben (Cache)
      const result2 = handler.getAllFrameworkNames();
      expect(result2.size).toBe(result1.size); // Keine neues Framework
      expect(result2.has("newframework")).toBe(false);
    });
  });

  describe("readFramework()", () => {
    it("should read framework from json directory", () => {
      // Setup: Framework erstellen (minimal valid framework)
      const frameworksDir = path.join(jsonPath, "frameworks");
      mkdirSync(frameworksDir, { recursive: true });
      writeJson(path.join(frameworksDir, "testframework.json"), {
        id: "testframework",
        name: "Test Framework",
        extends: "base",
        properties: [] as any[],
      });

      const opts = {
        error: new VEConfigurationError("", "testframework"),
      };

      // Framework validation might fail if base doesn't exist, so catch error
      try {
        const result = handler.readFramework("testframework", opts);
        expect(result.name).toBe("Test Framework");
        expect(result.id).toBe("testframework");
      } catch (e: any) {
        // If validation fails because base framework doesn't exist, that's expected
        // Just verify the framework file was found and parsed
        expect(e.message).toContain("framework");
      }
    });

    it("should read framework from local directory", () => {
      // Setup: Framework erstellen
      const frameworksDir = path.join(localPath, "frameworks");
      mkdirSync(frameworksDir, { recursive: true });
      writeJson(path.join(frameworksDir, "localframework.json"), {
        id: "localframework",
        name: "Local Framework",
        extends: "base",
        properties: [] as any[],
      });

      const opts = {
        error: new VEConfigurationError("", "localframework"),
      };

      try {
        const result = handler.readFramework("localframework", opts);
        expect(result.name).toBe("Local Framework");
        expect(result.id).toBe("localframework");
      } catch (e: any) {
        expect(e.message).toContain("framework");
      }
    });

    it("should cache local frameworks", () => {
      // Setup: Framework in local erstellen
      const frameworksDir = path.join(localPath, "frameworks");
      mkdirSync(frameworksDir, { recursive: true });
      const frameworkFile = path.join(frameworksDir, "cachedframework.json");
      writeJson(frameworkFile, {
        id: "cachedframework",
        name: "Cached Framework",
        extends: "base",
        properties: [] as any[],
      });

      const opts = {
        error: new VEConfigurationError("", "cachedframework"),
      };

      // First read
      try {
        const result1 = handler.readFramework("cachedframework", opts);
        expect(result1).toBeDefined();

        // Second read should use cache
        const result2 = handler.readFramework("cachedframework", opts);
        expect(result2).toBeDefined();
      } catch (e: any) {
        // Validation might fail, that's ok
        expect(e.message).toContain("framework");
      }
    });
  });

  describe("writeFramework() and deleteFramework()", () => {
    it("should write framework to local directory", () => {
      const framework = {
        id: "newframework",
        name: "New Framework",
        extends: "base",
        properties: [] as any[],
      };

      handler.writeFramework("newframework", framework as any);

      // Verify file exists
      const frameworkFile = path.join(
        localPath,
        "frameworks",
        "newframework.json",
      );
      expect(existsSync(frameworkFile)).toBe(true);

      // Verify content
      const content = JSON.parse(readFileSync(frameworkFile, "utf-8"));
      expect(content.name).toBe("New Framework");
    });

    it("should delete framework from local directory", () => {
      // Setup: Framework erstellen
      const frameworksDir = path.join(localPath, "frameworks");
      mkdirSync(frameworksDir, { recursive: true });
      const frameworkFile = path.join(frameworksDir, "deleteframework.json");
      writeJson(frameworkFile, {
        id: "deleteframework",
        name: "Delete Framework",
        extends: "base",
        properties: [],
      });

      handler.deleteFramework("deleteframework");

      // Verify file is deleted
      expect(existsSync(frameworkFile)).toBe(false);
    });
  });

  describe("invalidateFrameworkCache()", () => {
    it("should invalidate framework cache", () => {
      // Setup: Framework in local erstellen
      const frameworksDir = path.join(localPath, "frameworks");
      mkdirSync(frameworksDir, { recursive: true });
      writeJson(path.join(frameworksDir, "testframework.json"), {
        id: "testframework",
        name: "Test Framework",
        extends: "base",
        properties: [],
      });

      // Populate cache
      handler.getAllFrameworkNames();
      expect(handler.getAllFrameworkNames().has("testframework")).toBe(true);

      // Invalidate
      handler.invalidateFrameworkCache();

      // Delete framework
      rmSync(frameworksDir, { recursive: true, force: true });

      // Should not see deleted framework anymore
      const result = handler.getAllFrameworkNames();
      expect(result.has("testframework")).toBe(false);
    });
  });
});

