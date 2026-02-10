import { IFramework } from "../types.mjs";
import { VEConfigurationError } from "../backend-types.mjs";
import { IFrameworkPersistence } from "../persistence/interfaces.mjs";

export interface IReadFrameworkOptions {
  framework?: IFramework;
  frameworkPath?: string;
  error: VEConfigurationError;
}

/**
 * Service layer for framework operations
 * Wraps IFrameworkPersistence interface
 */
export class FrameworkService {
  constructor(private persistence: IFrameworkPersistence) {}

  getAllFrameworkNames(): Map<string, string> {
    return this.persistence.getAllFrameworkNames();
  }

  readFramework(frameworkId: string, opts: IReadFrameworkOptions): IFramework {
    return this.persistence.readFramework(frameworkId, opts);
  }

  writeFramework(frameworkId: string, framework: IFramework): void {
    this.persistence.writeFramework(frameworkId, framework);
  }

  deleteFramework(frameworkId: string): void {
    this.persistence.deleteFramework(frameworkId);
  }
}
