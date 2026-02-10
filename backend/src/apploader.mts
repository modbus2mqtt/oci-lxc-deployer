import { IApplication, IConfiguredPathes } from "@src/backend-types.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { IApplicationPersistence } from "./persistence/interfaces.mjs";
import { IReadApplicationOptions } from "./backend-types.mjs";
export class ApplicationLoader {
  constructor(
    private pathes: IConfiguredPathes,
    private persistence: IApplicationPersistence,
    private storage: StorageContext = StorageContext.getInstance(),
  ) {}
  /**
   * Reads the application.json for an application, supports inheritance and template list manipulation.
   * @param application Name of the application (optionally with json: prefix)
   * @param opts Options with applicationHierarchy and templates
   */
  public readApplicationJson(
    application: string,
    opts: IReadApplicationOptions,
  ): IApplication {
    // Handle json: prefix
    let appName = application;
    if (application.startsWith("json:")) {
      appName = application.replace(/^json:/, "");
    }

    // Use persistence to read application
    // This already handles inheritance, icons, and template processing
    return this.persistence.readApplication(appName, opts);
  }

  /**
   * Adds an error to the options error details array.
   * @param opts Read application options
   * @param error Error to add
   */
  private addErrorToOptions(
    opts: IReadApplicationOptions,
    error: Error | any,
  ): void {
    if (opts.error && Array.isArray(opts.error.details)) {
      opts.error.details.push(error);
    } else if (opts.error) {
      opts.error.details = [error];
    }
  }
}
