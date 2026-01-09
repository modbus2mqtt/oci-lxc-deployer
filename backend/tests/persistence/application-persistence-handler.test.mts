import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs, {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  statSync,
  readFileSync,
  existsSync,
} from "fs";
import { tmpdir } from "os";
import path from "path";
import { ApplicationPersistenceHandler } from "@src/persistence/application-persistence-handler.mjs";
import { JsonValidator } from "@src/jsonvalidator.mjs";
import {
  IReadApplicationOptions,
  VEConfigurationError,
} from "@src/backend-types.mjs";

describe("ApplicationPersistenceHandler", () => {
  let testDir: string;
  let jsonPath: string;
  let localPath: string;
  let schemaPath: string;
  let handler: ApplicationPersistenceHandler;
  let jsonValidator: JsonValidator;

  beforeEach(() => {
    // Setup temporäre Verzeichnisse
    testDir = mkdtempSync(path.join(tmpdir(), "app-handler-test-"));
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

    // ApplicationPersistenceHandler initialisieren
    handler = new ApplicationPersistenceHandler(
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

  describe("getAllAppNames()", () => {
    it("should return empty map when no applications exist", () => {
      const result = handler.getAllAppNames();
      expect(result.size).toBe(0);
    });

    it("should find applications in json directory", () => {
      // Setup: Application in json-Verzeichnis erstellen
      const appDir = path.join(jsonPath, "applications", "testapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Test App",
        installation: [],
      });

      const result = handler.getAllAppNames();
      expect(result.size).toBe(1);
      expect(result.has("testapp")).toBe(true);
      expect(result.get("testapp")).toBe(appDir);
    });

    it("should find applications in local directory", () => {
      // Setup: Application in local-Verzeichnis erstellen
      const appDir = path.join(localPath, "applications", "localapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Local App",
        installation: [],
      });

      const result = handler.getAllAppNames();
      expect(result.size).toBe(1);
      expect(result.has("localapp")).toBe(true);
    });

    it("should prefer local over json when same name exists", () => {
      // Setup: Application in beiden Verzeichnissen
      const jsonAppDir = path.join(jsonPath, "applications", "duplicate");
      const localAppDir = path.join(localPath, "applications", "duplicate");
      mkdirSync(jsonAppDir, { recursive: true });
      mkdirSync(localAppDir, { recursive: true });
      writeJson(path.join(jsonAppDir, "application.json"), {
        name: "JSON App",
        installation: [],
      });
      writeJson(path.join(localAppDir, "application.json"), {
        name: "Local App",
        installation: [],
      });

      const result = handler.getAllAppNames();
      expect(result.size).toBe(1);
      expect(result.get("duplicate")).toBe(localAppDir); // Local hat Priorität
    });

    it("should cache json directory (only loaded once)", () => {
      // Erster Aufruf
      const result1 = handler.getAllAppNames();

      // Application hinzufügen NACH erstem Aufruf
      const appDir = path.join(jsonPath, "applications", "newapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "New App",
        installation: [],
      });

      // Zweiter Aufruf sollte noch alte Daten haben (Cache)
      const result2 = handler.getAllAppNames();
      expect(result2.size).toBe(result1.size); // Keine neue Application
      expect(result2.has("newapp")).toBe(false);
    });
  });

  describe("listApplicationsForFrontend()", () => {
    it("should return empty array when no applications exist", () => {
      const result = handler.listApplicationsForFrontend();
      expect(result).toEqual([]);
    });

    it("should return applications with basic info", () => {
      // Setup: Application erstellen
      const appDir = path.join(jsonPath, "applications", "testapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Test App",
        description: "Test Description",
        installation: [],
      });

      const result = handler.listApplicationsForFrontend();
      expect(result.length).toBe(1);
      expect(result[0]?.name).toBe("Test App");
      expect(result[0]?.description).toBe("Test Description");
      expect(result[0]?.id).toBe("testapp");
    });

    it("should cache the result", () => {
      // Setup: Application erstellen
      const appDir = path.join(jsonPath, "applications", "testapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Test App",
        installation: [],
      });

      const result1 = handler.listApplicationsForFrontend();
      expect(result1.length).toBe(1);

      // Neue Application hinzufügen (sollte nicht erscheinen wegen Cache)
      const appDir2 = path.join(jsonPath, "applications", "newapp");
      mkdirSync(appDir2, { recursive: true });
      writeJson(path.join(appDir2, "application.json"), {
        name: "New App",
        installation: [],
      });

      const result2 = handler.listApplicationsForFrontend();
      expect(result2.length).toBe(1); // Noch gecacht
    });
  });

  describe("readApplication()", () => {
    it("should read application from json directory", () => {
      // Setup: Application erstellen
      const appDir = path.join(jsonPath, "applications", "testapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Test App",
        description: "Test Description",
        installation: ["template1.json"],
      });

      const opts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", "testapp"),
        taskTemplates: [],
      };

      const result = handler.readApplication("testapp", opts);
      expect(result.name).toBe("Test App");
      expect(result.description).toBe("Test Description");
      expect(result.id).toBe("testapp");
    });

    it("should handle inheritance", () => {
      // Setup: Parent Application
      const parentDir = path.join(jsonPath, "applications", "baseapp");
      mkdirSync(parentDir, { recursive: true });
      writeJson(path.join(parentDir, "application.json"), {
        name: "Base App",
        installation: ["base-template.json"],
      });

      // Setup: Child Application
      const childDir = path.join(localPath, "applications", "childapp");
      mkdirSync(childDir, { recursive: true });
      writeJson(path.join(childDir, "application.json"), {
        name: "Child App",
        extends: "baseapp",
        installation: ["child-template.json"],
      });

      const opts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", "childapp"),
        taskTemplates: [],
      };

      const result = handler.readApplication("childapp", opts);
      expect(result.name).toBe("Child App");
      expect(result.extends).toBe("baseapp");

      // Check that templates are processed
      const installationTemplates = opts.taskTemplates.find(
        (t) => t.task === "installation",
      );
      expect(installationTemplates).toBeDefined();
      expect(installationTemplates?.templates).toContain("base-template.json");
      expect(installationTemplates?.templates).toContain("child-template.json");
    });

    it("should detect cyclic inheritance", () => {
      // Setup: Application that extends itself
      const appDir = path.join(localPath, "applications", "cyclicapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Cyclic App",
        extends: "cyclicapp",
        installation: [],
      });

      const opts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", "cyclicapp"),
        taskTemplates: [],
      };

      // First call adds to hierarchy, second call should detect cycle
      expect(() => {
        handler.readApplication("cyclicapp", opts);
        // Second call with same appPath in hierarchy should throw
        handler.readApplication("cyclicapp", opts);
      }).toThrow("Cyclic inheritance");
    });

    it("should load icon if present", () => {
      // Setup: Application with icon
      const appDir = path.join(localPath, "applications", "iconapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Icon App",
        icon: "icon.png",
        installation: [],
      });

      // Create icon file (just a dummy file)
      writeFileSync(path.join(appDir, "icon.png"), "dummy icon data");

      const opts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", "iconapp"),
        taskTemplates: [],
      };

      const result = handler.readApplication("iconapp", opts);
      expect(result.icon).toBe("icon.png");
      expect(result.iconContent).toBeDefined();
      expect(result.iconType).toBe("image/png");
    });
  });

  describe("readApplicationIcon()", () => {
    it("should return null when application not found", () => {
      const result = handler.readApplicationIcon("nonexistent");
      expect(result).toBeNull();
    });

    it("should return icon data when icon exists", () => {
      // Setup: Application with icon
      const appDir = path.join(localPath, "applications", "iconapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Icon App",
        installation: [],
      });
      writeFileSync(path.join(appDir, "icon.png"), "dummy icon data");

      const result = handler.readApplicationIcon("iconapp");
      expect(result).not.toBeNull();
      expect(result?.iconContent).toBeDefined();
      expect(result?.iconType).toBe("image/png");
    });

    it("should prefer png over svg", () => {
      // Setup: Application with both icons
      const appDir = path.join(localPath, "applications", "bothicons");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Both Icons App",
        installation: [],
      });
      writeFileSync(path.join(appDir, "icon.png"), "png data");
      writeFileSync(path.join(appDir, "icon.svg"), "svg data");

      const result = handler.readApplicationIcon("bothicons");
      expect(result).not.toBeNull();
      expect(result?.iconType).toBe("image/png"); // png comes first
    });
  });

  describe("writeApplication() and deleteApplication()", () => {
    it("should write application to local directory", () => {
      const application = {
        name: "New App",
        description: "New Description",
        installation: [],
      };

      handler.writeApplication("newapp", application as any);

      // Verify file exists
      const appFile = path.join(
        localPath,
        "applications",
        "newapp",
        "application.json",
      );
      expect(statSync(appFile).isFile()).toBe(true);

      // Verify content
      const content = JSON.parse(readFileSync(appFile, "utf-8"));
      expect(content.name).toBe("New App");
    });

    it("should delete application from local directory", () => {
      // Setup: Application erstellen
      const appDir = path.join(localPath, "applications", "deleteapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Delete App",
        installation: [],
      });

      handler.deleteApplication("deleteapp");

      // Verify directory is deleted
      expect(existsSync(appDir)).toBe(false);
    });
  });

  describe("invalidateApplicationCache()", () => {
    it("should invalidate application cache", () => {
      // Setup: Application in local erstellen
      const appDir = path.join(localPath, "applications", "testapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Test App",
        installation: [],
      });

      // Populate cache
      handler.getAllAppNames();
      handler.listApplicationsForFrontend();
      expect(handler.getAllAppNames().has("testapp")).toBe(true);

      // Invalidate
      handler.invalidateApplicationCache();

      // Delete application
      rmSync(appDir, { recursive: true, force: true });

      // Should not see deleted app anymore
      const result = handler.getAllAppNames();
      expect(result.has("testapp")).toBe(false);
    });
  });
});

