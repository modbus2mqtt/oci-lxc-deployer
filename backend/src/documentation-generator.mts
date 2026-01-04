#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { StorageContext } from "./storagecontext.mjs";
import { VEConfigurationError, IApplication, IVEContext, IConfiguredPathes } from "./backend-types.mjs";
import { ITemplateReference, TemplateProcessor, type IProcessedTemplate } from "./templateprocessor.mjs";
import { DocumentationPathResolver } from "./documentation-path-resolver.mjs";
import { TemplateAnalyzer } from "./template-analyzer.mjs";
import { ApplicationDocumentGenerator } from "./application-document-generator.mjs";
import { TemplateDocumentGenerator } from "./template-document-generator.mjs";
import type { ICommand, TaskType, ITemplate } from "./types.mjs";

/**
 * Generates documentation for applications and templates.
 * Orchestrates the documentation generation process.
 */
export class DocumentationGenerator {
  private jsonPath: string;
  private localPath: string;
  private schemaPath: string;
  private htmlPath: string;
  private pathResolver: DocumentationPathResolver;
  private templateAnalyzer: TemplateAnalyzer;
  private applicationDocGenerator: ApplicationDocumentGenerator;
  private templateDocGenerator: TemplateDocumentGenerator;

  constructor(jsonPath: string, localPath: string, schemaPath: string, htmlPath?: string) {
    this.jsonPath = jsonPath;
    this.localPath = localPath;
    this.schemaPath = schemaPath;
    // Default htmlPath is docs/generated/ in project root
    const projectRoot = path.resolve(path.dirname(jsonPath));
    this.htmlPath = htmlPath || path.join(projectRoot, "docs", "generated");

    // Initialize helper classes
    const configuredPathes: IConfiguredPathes = {
      jsonPath: this.jsonPath,
      localPath: this.localPath,
      schemaPath: this.schemaPath,
    };
    this.pathResolver = new DocumentationPathResolver(configuredPathes);
    this.templateAnalyzer = new TemplateAnalyzer(this.pathResolver, configuredPathes);
    this.applicationDocGenerator = new ApplicationDocumentGenerator(
      this.pathResolver,
      this.templateAnalyzer,
      this.htmlPath,
      configuredPathes,
    );
    this.templateDocGenerator = new TemplateDocumentGenerator(
      this.pathResolver,
      this.templateAnalyzer,
    );
  }

  /**
   * Generates documentation for a specific application or all applications.
   */
  async generateDocumentation(applicationName?: string): Promise<void> {
    // Create html directory structure
    if (!fs.existsSync(this.htmlPath)) {
      fs.mkdirSync(this.htmlPath, { recursive: true });
    }
    // Note: Application-specific directories will be created in generateApplicationDocumentation

    const storageContext = StorageContext.getInstance();
    const allApps = storageContext.getAllAppNames();

    // Map to collect which applications use which templates
    const templateUsageMap = new Map<string, Set<string>>();  // template name -> set of app names

    if (applicationName) {
      const appPath = allApps.get(applicationName);
      if (!appPath) {
        throw new Error(
          `Application '${applicationName}' not found. Available: ${Array.from(allApps.keys()).join(", ")}`,
        );
      }
      await this.generateApplicationDocumentation(applicationName, appPath, templateUsageMap);
    } else {
      // Generate documentation for all applications
      // First pass: collect template usage information
      for (const [appName, appPath] of allApps) {
        await this.generateApplicationDocumentation(appName, appPath, templateUsageMap);
      }
      
      // Second pass: update usedByApplications for all processed templates
      // This is done after all applications are processed
      this.updateTemplateUsageInformation(templateUsageMap);
    }

    // Check for missing .md files (non-generated parts)
    this.checkMissingMarkdownFiles(applicationName);
  }

  /**
   * Updates usedByApplications for all templates based on collected usage information.
   */
  private updateTemplateUsageInformation(templateUsageMap: Map<string, Set<string>>): void {
    // This method can be used to update template usage information if needed
    // Currently, the information is collected during generateApplicationDocumentation
    // and used directly when generating template documentation
  }

  /**
   * Checks for missing .md files that are not generated (mandatory non-generated parts).
   */
  private checkMissingMarkdownFiles(applicationName?: string): void {
    const missingFiles: string[] = [];
    const storageContext = StorageContext.getInstance();
    const allApps = storageContext.getAllAppNames();

    const appsToCheck = applicationName 
      ? [[applicationName, allApps.get(applicationName)!].filter(([, appPath]) => appPath)]
      : Array.from(allApps.entries());

    for (const [appName, appPath] of appsToCheck) {
      if (!appPath || !appName) continue;

      // Check if application README.md exists in html directory
      const htmlReadmePath = path.join(this.htmlPath, `${appName}.md`);
      if (!fs.existsSync(htmlReadmePath)) {
        missingFiles.push(`Application README: ${appName}.md`);
      }

      // Check for template .md files in html/json/applications/<app-name>/templates
      const templatesDir = path.join(appPath, "templates");
      if (fs.existsSync(templatesDir)) {
        const templateFiles = fs.readdirSync(templatesDir)
          .filter(f => f.endsWith(".json"));
        
        for (const templateFile of templateFiles) {
          const templateName = templateFile.replace(/\.json$/, "");
          const htmlTemplatePath = path.join(this.htmlPath, "json", "applications", appName, "templates", `${templateName}.md`);
          if (!fs.existsSync(htmlTemplatePath)) {
            missingFiles.push(`Template: json/applications/${appName}/templates/${templateName}.md`);
          }
        }
      }

      // Check shared templates in html/json/shared/templates
      const sharedTemplatesDir = path.join(this.jsonPath, "shared", "templates");
      if (fs.existsSync(sharedTemplatesDir)) {
        const sharedTemplateFiles = fs.readdirSync(sharedTemplatesDir)
          .filter(f => f.endsWith(".json"));
        
        for (const templateFile of sharedTemplateFiles) {
          const templateName = templateFile.replace(/\.json$/, "");
          const htmlTemplatePath = path.join(this.htmlPath, "json", "shared", "templates", `${templateName}.md`);
          if (!fs.existsSync(htmlTemplatePath)) {
            missingFiles.push(`Shared Template: json/shared/templates/${templateName}.md`);
          }
        }
      }
    }

    if (missingFiles.length > 0) {
      console.log("\n⚠ Missing .md files (non-generated parts, must be created manually):");
      for (const file of missingFiles) {
        console.log(`  - ${file}`);
      }
    }
  }

  /**
   * Generates documentation for a single application.
   */
  private async generateApplicationDocumentation(
    applicationName: string,
    appPath: string,
    templateUsageMap: Map<string, Set<string>>,
  ): Promise<void> {
    console.log(`Generating documentation for application: ${applicationName}`);

    // Load application using TemplateProcessor (provides all needed information)
    let appData: IApplication | null = null;
    let commands: ICommand[] = [];
    let processedTemplates: IProcessedTemplate[] = [];
    let parentApp: IApplication | null = null;
    
    try {
      // Ensure StorageContext is initialized with correct paths
      StorageContext.setInstance(
        this.localPath,
        path.join(this.localPath, "storagecontext.json"),
        path.join(this.localPath, "secret.txt"),
      );
      
      const templateProcessor = new TemplateProcessor({
        jsonPath: this.jsonPath,
        localPath: this.localPath,
        schemaPath: this.schemaPath,
      });
      
      // Create a dummy VEContext for loading
      const dummyVeContext: IVEContext = {
        host: "dummy",
        port: 22,
        getStorageContext: () => StorageContext.getInstance(),
        getKey: () => "ve_dummy",
      };
      
      // Load installation task - this provides all needed information
      const loaded = await templateProcessor.loadApplication(
        applicationName,
        "installation" as TaskType,
        dummyVeContext,
        "sh", // Use sh for documentation generation
      );
      
      // Use data from loadApplication
      appData = loaded.application || null;
      commands = loaded.commands || [];
      processedTemplates = loaded.processedTemplates || [];
      
      // Get parent application if exists
      if (appData?.extends) {
        parentApp = await this.applicationDocGenerator.getParentApplication(appData.extends);
      }
    } catch (err) {
      // If loading fails, fall back to manual reading
      console.warn(`  ⚠ Could not load application for ${applicationName}: ${err instanceof Error ? err.message : String(err)}`);
      
      // Fallback: Read application.json manually
      const appJsonPath = path.join(appPath, "application.json");
      if (fs.existsSync(appJsonPath)) {
        appData = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
        if (appData?.extends) {
          parentApp = await this.applicationDocGenerator.getParentApplication(appData.extends);
        }
      } else {
        throw new Error(`application.json not found at ${appJsonPath}`);
      }
    }

    // Build skippedTemplates set from processedTemplates
    const skippedTemplates = new Set<string>();
    for (const template of processedTemplates) {
      if (template.skipped) {
        skippedTemplates.add(template.name);
      }
    }

    // Create directory structure for application-specific templates
    const appTemplatesDir = path.join(this.htmlPath, "json", "applications", applicationName, "templates");
    if (!fs.existsSync(appTemplatesDir)) {
      fs.mkdirSync(appTemplatesDir, { recursive: true });
    }
    
    // Create directory structure for shared templates
    const sharedTemplatesDir = path.join(this.htmlPath, "json", "shared", "templates");
    if (!fs.existsSync(sharedTemplatesDir)) {
      fs.mkdirSync(sharedTemplatesDir, { recursive: true });
    }

    // Generate README.md for application in html directory
    const htmlReadmePath = path.join(this.htmlPath, `${applicationName}.md`);
    const readmeContent = this.applicationDocGenerator.generateReadme(
      applicationName,
      appData || { name: applicationName, id: applicationName },
      parentApp,
      appPath,
      commands,
      skippedTemplates,
    );
    fs.writeFileSync(htmlReadmePath, readmeContent, "utf-8");
    console.log(`  ✓ Generated ${htmlReadmePath}`);

    // Update template usage map (which applications use which templates)
    for (const template of processedTemplates) {
      if (!template.skipped) {
        // Only add if template is not skipped
        if (!templateUsageMap.has(template.name)) {
          templateUsageMap.set(template.name, new Set());
        }
        templateUsageMap.get(template.name)!.add(applicationName);
      }
    }

    // Generate documentation for all processed templates
    // Use processedTemplates from loadApplication if available, otherwise fall back to manual discovery
    if (processedTemplates.length > 0) {
      // Use processedTemplates from loadApplication
      for (const template of processedTemplates) {
        // Update usedByApplications from templateUsageMap
        const templateWithUsage: IProcessedTemplate = {
          ...template,
        };
        if (templateUsageMap.has(template.name)) {
          templateWithUsage.usedByApplications = Array.from(templateUsageMap.get(template.name)!);
        }
        
        await this.generateTemplateDocumentation(
          template.path,
          applicationName,
          appPath,
          template.isShared,
          templateWithUsage,
        );
      }
    } else {
      // Fallback: Manual discovery (if loadApplication didn't provide processedTemplates)
      const templatesDir = path.join(appPath, "templates");
      if (fs.existsSync(templatesDir)) {
        const templateFiles = fs
          .readdirSync(templatesDir)
          .filter((f) => f.endsWith(".json"));

        for (const templateFile of templateFiles) {
          const templatePath = path.join(templatesDir, templateFile);
          await this.generateTemplateDocumentation(
            templatePath,
            applicationName,
            appPath,
          );
        }
      }

      // Also check shared templates referenced in installation
      if (appData?.installation) {
        const processedTemplateNames = new Set<string>();
        
        const processTemplateRecursively = async (templateName: string) => {
          if (processedTemplateNames.has(templateName)) {
            return; // Already processed
          }
          processedTemplateNames.add(templateName);
          
          const resolved = this.pathResolver.resolveTemplatePath(templateName, appPath);
          if (resolved) {
            await this.generateTemplateDocumentation(
              resolved.fullPath,
              applicationName,
              appPath,
              resolved.isShared,
            );
            
            // Read template to find referenced templates
            const templateData = this.pathResolver.loadTemplate(templateName, appPath);
            if (templateData) {
              const { TemplatePathResolver } = await import("./template-path-resolver.mjs");
              const referencedTemplates = TemplatePathResolver.extractTemplateReferences(templateData as any);
              for (const refTemplateName of referencedTemplates) {
                await processTemplateRecursively(refTemplateName);
              }
            }
          }
        };
        
        for (const templateRef of appData.installation) {
          const templateName = typeof templateRef === "string"
            ? templateRef
            : (templateRef as ITemplateReference).name;
          
          await processTemplateRecursively(templateName);
        }
      }
    }
  }

  /**
   * Generates documentation for a template.
   */
  private async generateTemplateDocumentation(
    templatePath: string,
    applicationName: string,
    appPath: string,
    isShared: boolean = false,
    templateInfo?: IProcessedTemplate,
  ): Promise<void> {
    if (!fs.existsSync(templatePath)) {
      console.warn(`  ⚠ Template not found: ${templatePath}`);
      return;
    }

    // Use templateData from templateInfo if available, otherwise load manually
    let templateData: ITemplate;
    if (templateInfo?.templateData) {
      templateData = templateInfo.templateData;
    } else {
      templateData = JSON.parse(
        fs.readFileSync(templatePath, "utf-8"),
      );
    }

    const templateName = path.basename(templatePath, ".json");
    const docName = `${templateName}.md`;
    
    // Determine if template is application-specific or shared
    // Use isShared from templateInfo if available
    const isLocal = templateInfo ? !templateInfo.isShared : !isShared;
    
    // Write to appropriate directory structure
    let htmlTemplatesPath: string;
    if (isLocal) {
      // Application-specific template: html/json/applications/<app-name>/templates/
      htmlTemplatesPath = path.join(this.htmlPath, "json", "applications", applicationName, "templates");
    } else {
      // Shared template: html/json/shared/templates/
      htmlTemplatesPath = path.join(this.htmlPath, "json", "shared", "templates");
    }
    
    // Ensure directory exists
    if (!fs.existsSync(htmlTemplatesPath)) {
      fs.mkdirSync(htmlTemplatesPath, { recursive: true });
    }
    
    const docPath = path.join(htmlTemplatesPath, docName);

    const docContent = await this.templateDocGenerator.generateDoc(
      templateName,
      templateData,
      applicationName,
      isShared,
      appPath,
      templateInfo,
    );

    fs.writeFileSync(docPath, docContent, "utf-8");
    console.log(`  ✓ Generated ${docPath}`);
  }
}

