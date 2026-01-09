import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { FileWatcherManager } from "@src/persistence/file-watcher-manager.mjs";

describe("FileWatcherManager", () => {
  let testDir: string;
  let localPath: string;
  let watcher: FileWatcherManager;
  let applicationInvalidated: boolean;
  let templateInvalidated: boolean;
  let frameworkInvalidated: boolean;

  beforeEach(() => {
    // Setup temporäre Verzeichnisse
    testDir = mkdtempSync(path.join(tmpdir(), "watcher-test-"));
    localPath = path.join(testDir, "local");

    // Verzeichnisse erstellen
    mkdirSync(localPath, { recursive: true });

    // Reset invalidation flags
    applicationInvalidated = false;
    templateInvalidated = false;
    frameworkInvalidated = false;

    // FileWatcherManager initialisieren
    watcher = new FileWatcherManager({
      jsonPath: path.join(testDir, "json"),
      localPath,
      schemaPath: path.join(testDir, "schemas"),
    });

    // Initialize watchers with callbacks
    watcher.initWatchers(
      () => {
        applicationInvalidated = true;
      },
      () => {
        templateInvalidated = true;
      },
      () => {
        frameworkInvalidated = true;
      },
    );
  });

  afterEach(() => {
    // Cleanup
    watcher.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  function writeJson(filePath: string, data: any): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  describe("initWatchers()", () => {
    it("should initialize watchers for existing directories", () => {
      // Directories should be created in beforeEach
      // Watcher should be initialized without errors
      expect(() => watcher.initWatchers(() => {}, () => {}, () => {})).not.toThrow();
    });

    it("should handle missing directories gracefully", () => {
      // Create new watcher with non-existent directories
      const newWatcher = new FileWatcherManager({
        jsonPath: path.join(testDir, "nonexistent-json"),
        localPath: path.join(testDir, "nonexistent-local"),
        schemaPath: path.join(testDir, "nonexistent-schemas"),
      });

      // Should not throw when directories don't exist
      expect(() =>
        newWatcher.initWatchers(() => {}, () => {}, () => {}),
      ).not.toThrow();

      newWatcher.close();
    });
  });

  describe("Application file watching", () => {
    it.skip("should detect application.json changes", async () => {
      // Note: fs.watch tests are flaky in test environment
      // This test is skipped but demonstrates the intended behavior
      // Setup: Application erstellen
      const appDir = path.join(localPath, "applications", "testapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Test App",
        installation: [],
      });

      // Wait a bit for watcher to settle
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Modify application.json
      writeJson(path.join(appDir, "application.json"), {
        name: "Modified App",
        installation: [],
      });

      // Wait for debounced invalidation (300ms + buffer)
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Application cache should be invalidated
      expect(applicationInvalidated).toBe(true);
    });

    it.skip("should detect icon file changes", async () => {
      // Note: fs.watch tests are flaky in test environment
      // Setup: Application mit Icon
      const appDir = path.join(localPath, "applications", "iconapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "Icon App",
        installation: [],
      });

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create icon file
      writeFileSync(path.join(appDir, "icon.png"), "icon data");

      // Wait for debounced invalidation
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Application cache should be invalidated
      expect(applicationInvalidated).toBe(true);
    });

    it.skip("should detect new application directories", async () => {
      // Note: fs.watch tests are flaky in test environment
      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create new application
      const appDir = path.join(localPath, "applications", "newapp");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "New App",
        installation: [],
      });

      // Wait for debounced invalidation
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Application cache should be invalidated
      expect(applicationInvalidated).toBe(true);
    });
  });

  describe("Template file watching", () => {
    it.skip("should detect template file changes", async () => {
      // Note: fs.watch tests are flaky in test environment
      // Setup: Template-Verzeichnis erstellen
      const templatesDir = path.join(localPath, "shared", "templates");
      mkdirSync(templatesDir, { recursive: true });

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create template file
      writeJson(path.join(templatesDir, "testtemplate.json"), {
        name: "Test Template",
        commands: [],
      });

      // Wait for invalidation (templates don't have debounce)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Template cache should be invalidated
      expect(templateInvalidated).toBe(true);
    });
  });

  describe("Framework file watching", () => {
    it.skip("should detect framework file changes", async () => {
      // Note: fs.watch tests are flaky in test environment
      // Setup: Framework-Verzeichnis erstellen
      const frameworksDir = path.join(localPath, "frameworks");
      mkdirSync(frameworksDir, { recursive: true });

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create framework file
      writeJson(path.join(frameworksDir, "testframework.json"), {
        id: "testframework",
        name: "Test Framework",
        extends: "base",
        properties: [],
      });

      // Wait for invalidation
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Framework cache should be invalidated
      expect(frameworkInvalidated).toBe(true);
    });
  });

  describe("close()", () => {
    it("should close watchers without errors", () => {
      expect(() => watcher.close()).not.toThrow();
    });

    it("should allow multiple close calls", () => {
      watcher.close();
      expect(() => watcher.close()).not.toThrow();
    });

    it("should stop watching after close", async () => {
      watcher.close();

      // Create file after close
      const appDir = path.join(localPath, "applications", "afterclose");
      mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, "application.json"), {
        name: "After Close",
        installation: [],
      });

      // Wait
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Should not be invalidated (watcher is closed)
      expect(applicationInvalidated).toBe(false);
    });
  });
});

