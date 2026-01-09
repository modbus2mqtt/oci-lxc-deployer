import {
  IApplication,
  IConfiguredPathes,
  IFramework,
  ITemplate,
  IReadApplicationOptions,
  VEConfigurationError,
} from "../backend-types.mjs";
import { IApplicationWeb } from "../types.mjs";
import { JsonValidator } from "../jsonvalidator.mjs";

/**
 * Base interface for all persistence implementations
 */
export interface IPersistence {
  /**
   * Invalidates all caches
   */
  invalidateCache(): void;

  /**
   * Cleanup resources (e.g., file watchers)
   */
  close(): void;
}

/**
 * Interface for application persistence operations
 */
export interface IApplicationPersistence extends IPersistence {
  /**
   * Returns all application names mapped to their paths
   * Local applications override json applications with the same name
   */
  getAllAppNames(): Map<string, string>;

  /**
   * Returns list of applications for frontend display
   * Only loads application.json and icons, NOT full templates
   * This method is optimized for the frontend application list
   */
  listApplicationsForFrontend(): IApplicationWeb[];

  /**
   * Reads an application with inheritance support
   * @param applicationName Name of the application (optionally with json: prefix)
   * @param opts Options for reading (inheritance, error handling, template processing)
   */
  readApplication(
    applicationName: string,
    opts: IReadApplicationOptions,
  ): IApplication;

  /**
   * Reads application icon as base64
   * @param applicationName Name of the application
   * @returns Object with iconContent (base64) and iconType (MIME type) or null if not found
   */
  readApplicationIcon(applicationName: string): {
    iconContent: string;
    iconType: string;
  } | null;

  /**
   * Writes application to local path
   * Invalidates cache automatically
   */
  writeApplication(applicationName: string, application: IApplication): void;

  /**
   * Deletes application from local path
   * Invalidates cache automatically
   */
  deleteApplication(applicationName: string): void;
}

/**
 * Interface for template persistence operations
 */
export interface ITemplatePersistence extends IPersistence {
  /**
   * Resolves template path (checks local first, then json)
   * @param templateName Name of the template (without .json)
   * @param isShared Whether template is in shared/templates directory
   * @returns Full path to template file or null if not found
   */
  resolveTemplatePath(
    templateName: string,
    isShared: boolean,
  ): string | null;

  /**
   * Loads a template from file system
   * @param templatePath Full path to template file
   * @returns Template data or null if not found
   */
  loadTemplate(templatePath: string): ITemplate | null;

  /**
   * Writes template to local path
   * Invalidates cache automatically
   */
  writeTemplate(
    templateName: string,
    template: ITemplate,
    isShared: boolean,
  ): void;

  /**
   * Deletes template from local path
   * Invalidates cache automatically
   */
  deleteTemplate(templateName: string, isShared: boolean): void;
}

/**
 * Interface for framework persistence operations
 */
export interface IFrameworkPersistence extends IPersistence {
  /**
   * Returns all framework names mapped to their paths
   * Local frameworks override json frameworks with the same name
   */
  getAllFrameworkNames(): Map<string, string>;

  /**
   * Reads a framework
   * @param frameworkId ID of the framework (without .json)
   * @param opts Options for reading (error handling)
   */
  readFramework(
    frameworkId: string,
    opts: {
      framework?: IFramework;
      frameworkPath?: string;
      error: VEConfigurationError;
    },
  ): IFramework;

  /**
   * Writes framework to local path
   * Invalidates cache automatically
   */
  writeFramework(frameworkId: string, framework: IFramework): void;

  /**
   * Deletes framework from local path
   * Invalidates cache automatically
   */
  deleteFramework(frameworkId: string): void;
}

