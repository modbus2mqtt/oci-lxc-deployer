import { IConfiguredPathes } from "../backend-types.mjs";
import { JsonValidator } from "../jsonvalidator.mjs";
import {
  IApplicationPersistence,
  ITemplatePersistence,
  IFrameworkPersistence,
} from "./interfaces.mjs";
import { FileWatcherManager } from "./file-watcher-manager.mjs";
import { ApplicationPersistenceHandler } from "./application-persistence-handler.mjs";
import { TemplatePersistenceHandler } from "./template-persistence-handler.mjs";
import { FrameworkPersistenceHandler } from "./framework-persistence-handler.mjs";

/**
 * File system implementation of persistence interfaces
 * Handles caching and file system operations with fs.watch
 * 
 * This class delegates to specialized handlers for better organization:
 * - ApplicationPersistenceHandler: Application operations
 * - TemplatePersistenceHandler: Template operations
 * - FrameworkPersistenceHandler: Framework operations
 * - FileWatcherManager: File watching and cache invalidation
 */
export class FileSystemPersistence
  implements IApplicationPersistence, ITemplatePersistence, IFrameworkPersistence
{
  private fileWatcher: FileWatcherManager;
  private applicationHandler: ApplicationPersistenceHandler;
  private templateHandler: TemplatePersistenceHandler;
  private frameworkHandler: FrameworkPersistenceHandler;

  constructor(
    private pathes: IConfiguredPathes,
    private jsonValidator: JsonValidator,
  ) {
    // Initialize handlers
    this.applicationHandler = new ApplicationPersistenceHandler(
      pathes,
      jsonValidator,
    );
    this.templateHandler = new TemplatePersistenceHandler(
      pathes,
      jsonValidator,
    );
    this.frameworkHandler = new FrameworkPersistenceHandler(
      pathes,
      jsonValidator,
    );

    // Initialize file watcher
    this.fileWatcher = new FileWatcherManager(pathes);
    this.fileWatcher.initWatchers(
      () => this.applicationHandler.invalidateApplicationCache(),
      () => this.templateHandler.invalidateCache(),
      () => this.frameworkHandler.invalidateFrameworkCache(),
    );
  }

  // IApplicationPersistence Implementation

  getAllAppNames() {
    return this.applicationHandler.getAllAppNames();
  }

  listApplicationsForFrontend() {
    return this.applicationHandler.listApplicationsForFrontend();
  }

  readApplication(applicationName: string, opts: any) {
    return this.applicationHandler.readApplication(applicationName, opts);
  }

  readApplicationIcon(applicationName: string) {
    return this.applicationHandler.readApplicationIcon(applicationName);
  }

  writeApplication(applicationName: string, application: any) {
    this.applicationHandler.writeApplication(applicationName, application);
  }

  deleteApplication(applicationName: string) {
    this.applicationHandler.deleteApplication(applicationName);
  }

  // ITemplatePersistence Implementation

  resolveTemplatePath(templateName: string, isShared: boolean) {
    return this.templateHandler.resolveTemplatePath(templateName, isShared);
  }

  loadTemplate(templatePath: string) {
    return this.templateHandler.loadTemplate(templatePath);
  }

  writeTemplate(templateName: string, template: any, isShared: boolean) {
    this.templateHandler.writeTemplate(templateName, template, isShared);
  }

  deleteTemplate(templateName: string, isShared: boolean) {
    this.templateHandler.deleteTemplate(templateName, isShared);
  }

  // IFrameworkPersistence Implementation

  getAllFrameworkNames() {
    return this.frameworkHandler.getAllFrameworkNames();
  }

  readFramework(frameworkId: string, opts: any) {
    return this.frameworkHandler.readFramework(frameworkId, opts);
  }

  writeFramework(frameworkId: string, framework: any) {
    this.frameworkHandler.writeFramework(frameworkId, framework);
  }

  deleteFramework(frameworkId: string) {
    this.frameworkHandler.deleteFramework(frameworkId);
  }

  // IPersistence Implementation

  invalidateCache(): void {
    this.applicationHandler.invalidateAllCaches();
    this.templateHandler.invalidateCache();
    this.frameworkHandler.invalidateAllCaches();
  }

  close(): void {
    this.fileWatcher.close();
  }
}
