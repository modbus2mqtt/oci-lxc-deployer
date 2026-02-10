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
   * @param category Optional category subdirectory for shared templates (e.g., "list")
   * @returns Object with fullPath, isShared flag, and category, or null if not found
   */
  static resolveTemplatePath(
    templateName: string,
    appPath: string,
    pathes: IConfiguredPathes,
    category?: string,
  ): { fullPath: string; isShared: boolean; category?: string } | null {
    // Ensure template name has .json extension
    const templateNameWithExt = templateName.endsWith(".json") ? templateName : `${templateName}.json`;
    const templatePath = path.join(appPath, "templates", templateNameWithExt);

    // Check app-specific first
    if (fs.existsSync(templatePath)) {
      return { fullPath: templatePath, isShared: false };
    }

    // For shared templates, check category subdirectory first if specified
    if (category) {
      const categoryLocalPath = path.join(pathes.localPath, "shared", "templates", category, templateNameWithExt);
      if (fs.existsSync(categoryLocalPath)) {
        return { fullPath: categoryLocalPath, isShared: true, category };
      }
      const categoryJsonPath = path.join(pathes.jsonPath, "shared", "templates", category, templateNameWithExt);
      if (fs.existsSync(categoryJsonPath)) {
        return { fullPath: categoryJsonPath, isShared: true, category };
      }
    }

    // Fallback to root shared templates (backward compatibility)
    const localSharedPath = path.join(pathes.localPath, "shared", "templates", templateNameWithExt);
    if (fs.existsSync(localSharedPath)) {
      return { fullPath: localSharedPath, isShared: true };
    }
    const jsonSharedPath = path.join(pathes.jsonPath, "shared", "templates", templateNameWithExt);
    if (fs.existsSync(jsonSharedPath)) {
      return { fullPath: jsonSharedPath, isShared: true };
    }

    // Auto-discovery: search in known category subdirectories
    const knownCategories = ["list"];
    for (const cat of knownCategories) {
      const catLocalPath = path.join(pathes.localPath, "shared", "templates", cat, templateNameWithExt);
      if (fs.existsSync(catLocalPath)) {
        return { fullPath: catLocalPath, isShared: true, category: cat };
      }
      const catJsonPath = path.join(pathes.jsonPath, "shared", "templates", cat, templateNameWithExt);
      if (fs.existsSync(catJsonPath)) {
        return { fullPath: catJsonPath, isShared: true, category: cat };
      }
    }

    return null;
  }

  /**
   * Resolves script path (checks application scripts, then shared scripts).
   * @param scriptName Script name (e.g., "test-script.sh")
   * @param appPath Application path (directory containing application.json)
   * @param pathes Configured paths (jsonPath, localPath, schemaPath)
   * @param category Optional category subdirectory for shared scripts (e.g., "list", "library")
   * @returns Full path to script or null if not found
   */
  static resolveScriptPath(
    scriptName: string,
    appPath: string,
    pathes: IConfiguredPathes,
    category?: string,
  ): string | null {
    // Check app-specific first
    const appScriptPath = path.join(appPath, "scripts", scriptName);
    if (fs.existsSync(appScriptPath)) {
      return appScriptPath;
    }

    // For shared scripts, check category subdirectory first if specified
    if (category) {
      const categoryLocalPath = path.join(pathes.localPath, "shared", "scripts", category, scriptName);
      if (fs.existsSync(categoryLocalPath)) {
        return categoryLocalPath;
      }
      const categoryJsonPath = path.join(pathes.jsonPath, "shared", "scripts", category, scriptName);
      if (fs.existsSync(categoryJsonPath)) {
        return categoryJsonPath;
      }
    }

    // Fallback to root shared scripts (backward compatibility)
    const localSharedPath = path.join(pathes.localPath, "shared", "scripts", scriptName);
    if (fs.existsSync(localSharedPath)) {
      return localSharedPath;
    }
    const jsonSharedPath = path.join(pathes.jsonPath, "shared", "scripts", scriptName);
    if (fs.existsSync(jsonSharedPath)) {
      return jsonSharedPath;
    }

    // Auto-discovery: search in known category subdirectories
    const knownCategories = ["list", "library"];
    for (const cat of knownCategories) {
      const catLocalPath = path.join(pathes.localPath, "shared", "scripts", cat, scriptName);
      if (fs.existsSync(catLocalPath)) {
        return catLocalPath;
      }
      const catJsonPath = path.join(pathes.jsonPath, "shared", "scripts", cat, scriptName);
      if (fs.existsSync(catJsonPath)) {
        return catJsonPath;
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
   * @param category Optional category subdirectory (e.g., "list")
   * @returns Array of template directory paths to search
   */
  static buildTemplatePathes(
    applicationHierarchy: string[],
    pathes: IConfiguredPathes,
    category?: string,
  ): string[] {
    const templatePathes = applicationHierarchy.map((appDir) =>
      path.join(appDir, "templates"),
    );

    // Add category paths first if specified
    if (category) {
      templatePathes.push(
        path.join(pathes.localPath, "shared", "templates", category),
      );
      templatePathes.push(
        path.join(pathes.jsonPath, "shared", "templates", category),
      );
    }

    // Always include root paths for backward compatibility
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
   * @param category Optional category subdirectory (e.g., "list", "library")
   * @returns Array of script directory paths to search
   */
  static buildScriptPathes(
    applicationHierarchy: string[],
    pathes: IConfiguredPathes,
    category?: string,
  ): string[] {
    const scriptPathes = applicationHierarchy.map((appDir) =>
      path.join(appDir, "scripts"),
    );

    // Add category paths first if specified
    if (category) {
      scriptPathes.push(
        path.join(pathes.localPath, "shared", "scripts", category),
      );
      scriptPathes.push(
        path.join(pathes.jsonPath, "shared", "scripts", category),
      );
    }

    // Always include root paths for backward compatibility
    scriptPathes.push(path.join(pathes.localPath, "shared", "scripts"));
    scriptPathes.push(path.join(pathes.jsonPath, "shared", "scripts"));
    return scriptPathes;
  }
}

