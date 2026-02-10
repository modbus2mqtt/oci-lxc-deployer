import { watch, FSWatcher } from "fs";
import path from "path";
import fs from "fs";
import { IConfiguredPathes } from "../backend-types.mjs";

/**
 * Manages file system watchers for local directories
 * Handles fs.watch initialization and cache invalidation callbacks
 */
export class FileWatcherManager {
  private localAppsWatcher?: FSWatcher;
  private localTemplatesWatcher?: FSWatcher;
  private localFrameworksWatcher?: FSWatcher;
  private localAddonsWatcher?: FSWatcher;
  private invalidateTimeout: NodeJS.Timeout | undefined;
  private readonly DEBOUNCE_MS = 300;

  constructor(private pathes: IConfiguredPathes) {}

  /**
   * Initialisiert fs.watch für local-Verzeichnisse
   * Node.js 20.11.0+ unterstützt rekursives Watching nativ
   */
  initWatchers(
    onApplicationChange: () => void,
    onTemplateChange: () => void,
    onFrameworkChange: () => void,
    onAddonChange?: () => void,
  ): void {
    const localAppsDir = path.join(this.pathes.localPath, "applications");
    const localTemplatesDir = path.join(
      this.pathes.localPath,
      "shared",
      "templates",
    );
    const localFrameworksDir = path.join(this.pathes.localPath, "frameworks");
    const localAddonsDir = path.join(this.pathes.localPath, "addons");

    // Watch local applications (rekursiv)
    if (fs.existsSync(localAppsDir)) {
      this.localAppsWatcher = watch(
        localAppsDir,
        { recursive: true },
        (eventType: string, filename: string | null) => {
          if (filename && this.isApplicationChange(filename)) {
            this.debouncedInvalidate(onApplicationChange);
          }
        },
      );
    }

    // Watch local shared templates (rekursiv)
    // Bei Template-Änderungen: gesamten Template-Cache invalidieren
    if (fs.existsSync(localTemplatesDir)) {
      this.localTemplatesWatcher = watch(
        localTemplatesDir,
        { recursive: true },
        (eventType: string, filename: string | null) => {
          if (filename && filename.endsWith(".json")) {
            // Template-Änderungen sind selten, invalidieren gesamten Template-Cache
            onTemplateChange();
          }
        },
      );
    }

    // Watch local frameworks (rekursiv)
    if (fs.existsSync(localFrameworksDir)) {
      this.localFrameworksWatcher = watch(
        localFrameworksDir,
        { recursive: true },
        (eventType: string, filename: string | null) => {
          if (filename && filename.endsWith(".json")) {
            onFrameworkChange();
          }
        },
      );
    }

    // Watch local addons
    if (onAddonChange && fs.existsSync(localAddonsDir)) {
      this.localAddonsWatcher = watch(
        localAddonsDir,
        { recursive: false },
        (eventType: string, filename: string | null) => {
          if (filename && filename.endsWith(".json")) {
            onAddonChange();
          }
        },
      );
    }
  }

  /**
   * Prüft ob eine Änderung relevant für Applications ist
   */
  private isApplicationChange(filename: string): boolean {
    // Ignoriere versteckte Dateien
    if (filename.startsWith(".")) return false;

    // Relevante Änderungen:
    // - application.json
    // - icon.png/svg
    // - Verzeichnis-Änderungen (neue/gelöschte Applications)
    return (
      filename.endsWith("application.json") ||
      filename.endsWith("icon.png") ||
      filename.endsWith("icon.svg") ||
      !filename.includes(".") // Verzeichnis-Name
    );
  }

  /**
   * Debounced Invalidation für Application-Cache
   */
  private debouncedInvalidate(callback: () => void): void {
    if (this.invalidateTimeout) {
      clearTimeout(this.invalidateTimeout);
    }
    this.invalidateTimeout = setTimeout(() => {
      callback();
      this.invalidateTimeout = undefined;
    }, this.DEBOUNCE_MS);
  }

  /**
   * Cleanup beim Shutdown
   */
  close(): void {
    if (this.localAppsWatcher) {
      this.localAppsWatcher.close();
    }
    if (this.localTemplatesWatcher) {
      this.localTemplatesWatcher.close();
    }
    if (this.localFrameworksWatcher) {
      this.localFrameworksWatcher.close();
    }
    if (this.localAddonsWatcher) {
      this.localAddonsWatcher.close();
    }
    if (this.invalidateTimeout) {
      clearTimeout(this.invalidateTimeout);
    }
  }
}
