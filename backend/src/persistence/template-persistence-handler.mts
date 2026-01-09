import path from "path";
import fs from "fs";
import { IConfiguredPathes, ITemplate } from "../backend-types.mjs";
import { JsonValidator } from "../jsonvalidator.mjs";

/**
 * Handles template-specific persistence operations
 * Separated from main FileSystemPersistence for better organization
 */
export class TemplatePersistenceHandler {
  // Template Cache
  private templateCache: Map<string, { data: ITemplate; mtime: number }> =
    new Map();

  constructor(
    private pathes: IConfiguredPathes,
    private jsonValidator: JsonValidator,
  ) {}

  resolveTemplatePath(
    templateName: string,
    isShared: boolean,
  ): string | null {
    if (isShared) {
      // Check local first, then json
      const localPath = path.join(
        this.pathes.localPath,
        "shared",
        "templates",
        templateName.endsWith(".json") ? templateName : `${templateName}.json`,
      );
      const jsonPath = path.join(
        this.pathes.jsonPath,
        "shared",
        "templates",
        templateName.endsWith(".json") ? templateName : `${templateName}.json`,
      );

      if (fs.existsSync(localPath)) {
        return localPath;
      }
      if (fs.existsSync(jsonPath)) {
        return jsonPath;
      }
      return null;
    } else {
      // Application-specific template - need appPath
      // This method signature doesn't include appPath, so we can't resolve it here
      // This is a limitation - we might need to adjust the interface
      // For now, return null
      return null;
    }
  }

  loadTemplate(templatePath: string): ITemplate | null {
    // Check cache first
    if (!fs.existsSync(templatePath)) {
      return null;
    }

    const mtime = fs.statSync(templatePath).mtimeMs;
    const cached = this.templateCache.get(templatePath);
    if (cached && cached.mtime === mtime) {
      return cached.data;
    }

    // Load and validate
    try {
      const templateData = this.jsonValidator.serializeJsonFileWithSchema<ITemplate>(
        templatePath,
        "template",
      );

      // Cache it
      this.templateCache.set(templatePath, { data: templateData, mtime });

      return templateData;
    } catch (e: Error | any) {
      return null;
    }
  }

  writeTemplate(
    templateName: string,
    template: ITemplate,
    isShared: boolean,
  ): void {
    const templateFileName = templateName.endsWith(".json")
      ? templateName
      : `${templateName}.json`;

    if (isShared) {
      const templateDir = path.join(
        this.pathes.localPath,
        "shared",
        "templates",
      );
      fs.mkdirSync(templateDir, { recursive: true });
      const templateFile = path.join(templateDir, templateFileName);
      fs.writeFileSync(templateFile, JSON.stringify(template, null, 2));
    } else {
      // Application-specific template - need appPath
      // This is a limitation - we might need to adjust the interface
      throw new Error(
        "Writing application-specific templates requires appPath (not implemented)",
      );
    }

    // Invalidate cache
    this.templateCache.clear();
  }

  deleteTemplate(templateName: string, isShared: boolean): void {
    const templateFileName = templateName.endsWith(".json")
      ? templateName
      : `${templateName}.json`;

    if (isShared) {
      const templateFile = path.join(
        this.pathes.localPath,
        "shared",
        "templates",
        templateFileName,
      );
      if (fs.existsSync(templateFile)) {
        fs.unlinkSync(templateFile);
      }
    } else {
      // Application-specific template - need appPath
      throw new Error(
        "Deleting application-specific templates requires appPath (not implemented)",
      );
    }

    // Invalidate cache
    this.templateCache.clear();
  }

  invalidateCache(): void {
    this.templateCache.clear();
  }
}

