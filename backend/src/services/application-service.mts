import {
  IApplication,
  IReadApplicationOptions,
} from "../backend-types.mjs";
import { IApplicationWeb } from "../types.mjs";
import { IApplicationPersistence } from "../persistence/interfaces.mjs";

/**
 * Service layer for application operations
 * Wraps IApplicationPersistence interface
 */
export class ApplicationService {
  constructor(
    private persistence: IApplicationPersistence,
  ) {}

  getAllAppNames(): Map<string, string> {
    return this.persistence.getAllAppNames();
  }

  getLocalAppNames(): Map<string, string> {
    return this.persistence.getLocalAppNames();
  }

  listApplicationsForFrontend(): IApplicationWeb[] {
    return this.persistence.listApplicationsForFrontend();
  }

  readApplication(
    applicationName: string,
    opts: IReadApplicationOptions,
  ): IApplication {
    return this.persistence.readApplication(applicationName, opts);
  }

  readApplicationIcon(applicationName: string): {
    iconContent: string;
    iconType: string;
  } | null {
    return this.persistence.readApplicationIcon(applicationName);
  }

  writeApplication(applicationName: string, application: IApplication): void {
    this.persistence.writeApplication(applicationName, application);
  }

  deleteApplication(applicationName: string): void {
    this.persistence.deleteApplication(applicationName);
  }
}

