#!/usr/bin/env node
import { TemplatePathResolver } from "./templates/template-path-resolver.mjs";
import type { IConfiguredPathes } from "./backend-types.mjs";
import type { ITemplate } from "./types.mjs";

/**
 * Resolves paths and loads templates for documentation generation.
 */
export class DocumentationPathResolver {
  private configuredPathes: IConfiguredPathes;

  constructor(configuredPathes: IConfiguredPathes) {
    this.configuredPathes = configuredPathes;
  }

  /**
   * Gets configured paths.
   */
  getConfiguredPathes(): IConfiguredPathes {
    return this.configuredPathes;
  }

  /**
   * Resolves template path (checks local first, then shared).
   * @returns Object with fullPath and isShared flag, or null if not found
   */
  resolveTemplatePath(
    templateName: string,
    appPath: string,
  ): { fullPath: string; isShared: boolean } | null {
    return TemplatePathResolver.resolveTemplatePath(
      templateName,
      appPath,
      this.configuredPathes,
    );
  }

  /**
   * Loads a template from file system.
   * @returns Template data or null if not found/error
   */
  loadTemplate(templateName: string, appPath: string): ITemplate | null {
    return TemplatePathResolver.loadTemplate(
      templateName,
      appPath,
      this.configuredPathes,
    );
  }

  /**
   * Normalizes template name by removing .json extension.
   */
  normalizeTemplateName(templateName: string): string {
    return TemplatePathResolver.normalizeTemplateName(templateName);
  }

  /**
   * Generates markdown documentation filename from template name.
   */
  getTemplateDocName(templateName: string): string {
    return TemplatePathResolver.getTemplateDocName(templateName);
  }

  /**
   * Resolves script path (checks application scripts, then shared scripts).
   * @returns Full path to script or null if not found
   */
  resolveScriptPath(scriptName: string, appPath: string): string | null {
    return TemplatePathResolver.resolveScriptPath(
      scriptName,
      appPath,
      this.configuredPathes,
    );
  }
}
