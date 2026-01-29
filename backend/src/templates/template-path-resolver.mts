#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import type { IConfiguredPathes } from "../backend-types.mjs";
import type { ITemplate } from "../types.mjs";

/**
 * Utility class for resolving template and script paths.
 * Provides centralized path resolution logic that can be reused across the codebase.
 */
export class TemplatePathResolver {
  /**
   * Resolves template path (checks local first, then shared).
   * @param templateName Template name (with or without .json extension)
   * @param appPath Application path (directory containing application.json)
   * @param pathes Configured paths (jsonPath, localPath, schemaPath)
   * @returns Object with fullPath and isShared flag, or null if not found
   */
  static resolveTemplatePath(
    templateName: string,
    appPath: string,
    pathes: IConfiguredPathes,
  ): { fullPath: string; isShared: boolean } | null {
    // Ensure template name has .json extension
    const templateNameWithExt = templateName.endsWith(".json") ? templateName : `${templateName}.json`;
    const templatePath = path.join(appPath, "templates", templateNameWithExt);
    const isShared = !fs.existsSync(templatePath);
    const fullPath = isShared
      ? path.join(pathes.jsonPath, "shared", "templates", templateNameWithExt)
      : templatePath;
    
    if (!fs.existsSync(fullPath)) {
      return null;
    }
    
    return { fullPath, isShared };
  }

  /**
   * Resolves script path (checks application scripts, then shared scripts).
   * @param scriptName Script name (e.g., "test-script.sh")
   * @param appPath Application path (directory containing application.json)
   * @param pathes Configured paths (jsonPath, localPath, schemaPath)
   * @returns Full path to script or null if not found
   */
  static resolveScriptPath(
    scriptName: string,
    appPath: string,
    pathes: IConfiguredPathes,
  ): string | null {
    const scriptPaths = [
      path.join(appPath, "scripts", scriptName),
      path.join(pathes.jsonPath, "shared", "scripts", scriptName),
      path.join(pathes.localPath, "shared", "scripts", scriptName),
    ];
    
    for (const candidatePath of scriptPaths) {
      if (fs.existsSync(candidatePath)) {
        return candidatePath;
      }
    }
    
    return null;
  }

  /**
   * Normalizes template name by removing .json extension.
   * @param templateName Template name (with or without .json extension)
   * @returns Normalized template name without .json extension
   */
  static normalizeTemplateName(templateName: string): string {
    return templateName.replace(/\.json$/, "");
  }

  /**
   * Generates markdown documentation filename from template name.
   * @param templateName Template name (with or without .json extension)
   * @returns Markdown filename (e.g., "test-template.md")
   */
  static getTemplateDocName(templateName: string): string {
    return templateName.endsWith(".json")
      ? templateName.slice(0, -5) + ".md"
      : templateName + ".md";
  }

  /**
   * Loads a template from file system.
   * @param templateName Template name (with or without .json extension)
   * @param appPath Application path (directory containing application.json)
   * @param pathes Configured paths (jsonPath, localPath, schemaPath)
   * @returns Template data or null if not found/error
   */
  static loadTemplate(
    templateName: string,
    appPath: string,
    pathes: IConfiguredPathes,
  ): ITemplate | null {
    const resolved = this.resolveTemplatePath(templateName, appPath, pathes);
    if (!resolved) {
      return null;
    }
    
    try {
      return JSON.parse(fs.readFileSync(resolved.fullPath, "utf-8")) as ITemplate;
    } catch {
      return null;
    }
  }

  /**
   * Extracts all template references from a template's commands.
   * @param templateData Template data
   * @returns Array of template names referenced in commands
   */
  static extractTemplateReferences(templateData: ITemplate): string[] {
    const references: string[] = [];
    
    if (templateData.commands && Array.isArray(templateData.commands)) {
      for (const cmd of templateData.commands) {
        if (cmd && cmd.template) {
          references.push(cmd.template);
        }
      }
    }
    
    return references;
  }

  /**
   * Finds a file in an array of base paths (searches in order, returns first match).
   * This is used by TemplateProcessor which searches through application hierarchy.
   * @param pathes Array of base paths to search in
   * @param name File name to find (e.g., "template.json" or "script.sh")
   * @returns Full path to file or undefined if not found
   */
  static findInPathes(pathes: string[], name: string): string | undefined {
    for (const basePath of pathes) {
      const candidate = path.join(basePath, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Builds template paths array from application hierarchy.
   * @param applicationHierarchy Array of application paths (from parent to child)
   * @param pathes Configured paths
   * @returns Array of template directory paths to search
   */
  static buildTemplatePathes(
    applicationHierarchy: string[],
    pathes: IConfiguredPathes,
  ): string[] {
    const templatePathes = applicationHierarchy.map((appDir) =>
      path.join(appDir, "templates"),
    );
    templatePathes.push(
      path.join(pathes.localPath, "shared", "templates"),
    );
    templatePathes.push(path.join(pathes.jsonPath, "shared", "templates"));
    return templatePathes;
  }

  /**
   * Builds script paths array from application hierarchy.
   * @param applicationHierarchy Array of application paths (from parent to child)
   * @param pathes Configured paths
   * @returns Array of script directory paths to search
   */
  static buildScriptPathes(
    applicationHierarchy: string[],
    pathes: IConfiguredPathes,
  ): string[] {
    const scriptPathes = applicationHierarchy.map((appDir) =>
      path.join(appDir, "scripts"),
    );
    scriptPathes.push(path.join(pathes.localPath, "shared", "scripts"));
    scriptPathes.push(path.join(pathes.jsonPath, "shared", "scripts"));
    return scriptPathes;
  }
}

