/**
 * @deprecated Use ContextManager and PersistenceManager instead
 * This file provides backward compatibility during migration
 *
 * StorageContext is now split into:
 * - ContextManager: Manages execution contexts (VE, VM, VMInstall)
 * - PersistenceManager: Manages persistence and services (Applications, Templates, Frameworks)
 *
 * For entity access (Applications, Templates, Frameworks), use PersistenceManager.
 * For context management (VE, VM, VMInstall), use ContextManager via PersistenceManager.
 */

import {
  ContextManager,
  VMContext,
  VMInstallContext,
} from "./context-manager.mjs";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";
import {
  VEConfigurationError,
  storageKey as storageContextKey,
  IContext,
} from "./backend-types.mjs";
import { IApplicationWeb } from "./types.mjs";

/**
 * Proxy class that delegates to ContextManager and adds entity methods
 * that delegate to PersistenceManager services
 */
class StorageContextProxy implements IContext {
  private contextManager: ContextManager;
  private pm: PersistenceManager;

  constructor(contextManager: ContextManager, pm: PersistenceManager) {
    this.contextManager = contextManager;
    this.pm = pm;
  }

  // Delegate all ContextManager methods
  getLocalPath(): string {
    return this.contextManager.getLocalPath();
  }

  getJsonPath(): string {
    return this.contextManager.getJsonPath();
  }

  getSchemaPath(): string {
    return this.contextManager.getSchemaPath();
  }

  getKey(): string {
    return this.contextManager.getKey();
  }

  getJsonValidator() {
    return this.contextManager.getJsonValidator();
  }

  getTemplateProcessor() {
    return this.contextManager.getTemplateProcessor();
  }

  getCurrentVEContext() {
    return this.contextManager.getCurrentVEContext();
  }

  setVMContext(vmContext: any) {
    return this.contextManager.setVMContext(vmContext);
  }

  setVEContext(veContext: any) {
    return this.contextManager.setVEContext(veContext);
  }

  setVMInstallContext(vmInstallContext: any) {
    return this.contextManager.setVMInstallContext(vmInstallContext);
  }

  getVEContextByKey(key: string) {
    return this.contextManager.getVEContextByKey(key);
  }

  getVMContextByHostname(hostname: string) {
    return this.contextManager.getVMContextByHostname(hostname);
  }

  getVMInstallContextByHostnameAndApplication(
    hostname: string,
    application: string,
  ) {
    return this.contextManager.getVMInstallContextByHostnameAndApplication(
      hostname,
      application,
    );
  }

  listSshConfigs() {
    return this.contextManager.listSshConfigs();
  }

  getCurrentSsh() {
    return this.contextManager.getCurrentSsh();
  }

  // Context base class methods
  set(key: string, value: any): void {
    return (this.contextManager as any).set(key, value);
  }

  get(key: string): any {
    return (this.contextManager as any).get(key);
  }

  has(key: string): boolean {
    return (this.contextManager as any).has(key);
  }

  remove(key: string): void {
    return (this.contextManager as any).remove(key);
  }

  clear(): void {
    return (this.contextManager as any).clear();
  }

  keys(): string[] {
    return (this.contextManager as any).keys();
  }

  // Entity methods delegate to PersistenceManager services
  getAllAppNames(): Map<string, string> {
    return this.pm.getApplicationService().getAllAppNames();
  }

  listApplications(): IApplicationWeb[] {
    return this.pm.getApplicationService().listApplicationsForFrontend();
  }

  getAllFrameworkNames(): Map<string, string> {
    return this.pm.getFrameworkService().getAllFrameworkNames();
  }
}

/**
 * @deprecated Use PersistenceManager.initialize() instead
 */
function setStorageContextInstance(
  localPath: string,
  storageContextFilePath: string,
  secretFilePath: string,
): StorageContext {
  // Initialize PersistenceManager (which creates ContextManager)
  PersistenceManager.initialize(
    localPath,
    storageContextFilePath,
    secretFilePath,
  );

  // Return a proxy that delegates to ContextManager
  return getStorageContextInstance();
}

/**
 * @deprecated Use PersistenceManager.getInstance().getContextManager() instead
 */
function getStorageContextInstance(): StorageContext {
  try {
    const pm = PersistenceManager.getInstance();
    const contextManager = pm.getContextManager();
    // Return a proxy that delegates all calls to ContextManager
    return new StorageContextProxy(contextManager, pm);
  } catch {
    throw new VEConfigurationError(
      "StorageContext instance not set. Use PersistenceManager.initialize() first.",
      storageContextKey,
    );
  }
}

// Export as class for backward compatibility
// Support both static methods and constructor (for tests that use new StorageContext())
export class StorageContext extends StorageContextProxy {
  static setInstance = setStorageContextInstance;
  static getInstance = getStorageContextInstance;
  // Use getters to avoid initialization order issues
  static get VMContext() {
    return VMContext;
  }
  static get VMInstallContext() {
    return VMInstallContext;
  }

  // Constructor for backward compatibility (creates a proxy instance)
  constructor(
    localPath: string,
    storageContextFilePath: string,
    secretFilePath: string,
  ) {
    // Initialize PersistenceManager if not already initialized
    try {
      PersistenceManager.getInstance();
    } catch {
      PersistenceManager.initialize(
        localPath,
        storageContextFilePath,
        secretFilePath,
      );
    }
    // Get the context manager and persistence manager
    const pm = PersistenceManager.getInstance();
    const contextManager = pm.getContextManager();
    // Call super constructor with the context manager and persistence manager
    super(contextManager, pm);
  }
}

// Re-export for backward compatibility
export { VMContext, VMInstallContext } from "./context-manager.mjs";
