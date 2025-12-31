import path from "node:path";
import fs from "fs";
import { fileURLToPath } from "url";
import { JsonValidator } from "./jsonvalidator.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { ApplicationLoader } from "./apploader.mjs";
import { IReadApplicationOptions } from "./apploader.mjs";
import { TaskType } from "./types.mjs";
import { VEConfigurationError, VELoadApplicationError, IVEContext } from "./backend-types.mjs";
import { TemplatePathResolver } from "./template-path-resolver.mjs";

function findTemplateDirs(dir: string): string[] {
  let results: string[] = [];
  // Check if directory exists before trying to read it
  if (!fs.existsSync(dir)) {
    return results;
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "templates") {
          results.push(fullPath);
        } else {
          results = results.concat(findTemplateDirs(fullPath));
        }
      }
    }
  } catch {
    // Ignore errors reading directory (e.g., permission denied)
    // Return empty results for this directory
  }
  return results;
}

function findApplicationFiles(dir: string): string[] {
  let results: string[] = [];
  // Check if directory exists before trying to read it
  if (!fs.existsSync(dir)) {
    return results;
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Check if there's an application.json in this directory
        const appJsonPath = path.join(fullPath, "application.json");
        if (fs.existsSync(appJsonPath)) {
          results.push(appJsonPath);
        }
        // Recurse into subdirectories
        results = results.concat(findApplicationFiles(fullPath));
      }
    }
  } catch {
    // Ignore errors reading directory (e.g., permission denied)
    // Return empty results for this directory
  }
  return results;
}

export async function validateAllJson(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, "..");
  const rootDir = path.resolve(projectRoot, "..");
  const schemasDir = path.join(rootDir, "schemas");
  
  // Use the same paths as webapp.mts: localPath and jsonPath
  // Default localPath is "local" in current working directory, or "examples" for webapp
  // For validation, we'll use "local" as default
  const defaultLocalPath = path.join(process.cwd(), "local");
  const localPath = process.env.LXC_MANAGER_LOCAL_PATH || defaultLocalPath;
  const jsonPath = path.join(rootDir, "json");

  let hasError = false;

  // Initialize validator
  let validator: JsonValidator;
  try {
    validator = new JsonValidator(schemasDir);
  } catch (err: any) {
    console.error("Schema validation failed during validator initialization:");
    if (err && err.details) {
      for (const detail of err.details) {
        console.error(`  - ${detail.message || detail}`);
      }
    } else {
      console.error(err);
    }
    process.exit(2);
  }

  // Validate templates - only search in localPath and jsonPath (like webapp.mts)
  console.log("Validating templates...");
  const templateDirs: string[] = [];
  
  // Search in localPath
  if (fs.existsSync(localPath)) {
    const localTemplateDirs = findTemplateDirs(localPath);
    templateDirs.push(...localTemplateDirs);
  }
  
  // Search in jsonPath
  if (fs.existsSync(jsonPath)) {
    const jsonTemplateDirs = findTemplateDirs(jsonPath);
    templateDirs.push(...jsonTemplateDirs);
  }
  
  const templateSchemaPath = path.join(schemasDir, "template.schema.json");

  for (const dir of templateDirs) {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(dir, file);
      // Calculate relative path from the base (localPath or jsonPath)
      const relPath = path.relative(
        filePath.startsWith(localPath) ? localPath : jsonPath,
        filePath
      );
      try {
        validator.serializeJsonFileWithSchema(filePath, templateSchemaPath);
        console.log(`✔ Valid template: ${relPath}`);
      } catch (err: any) {
        hasError = true;
        const schemaName = path.basename(templateSchemaPath);
        console.error(`✖ Invalid template: ${relPath} [${schemaName}]`);
        if (err && err.details) {
          for (const detail of err.details) {
            const isAdditional =
              detail.message &&
              detail.message.includes("must NOT have additional properties");
            if (
              isAdditional &&
              detail.params &&
              detail.params.additionalProperty
            ) {
              console.error(
                `  - ${detail.message} (property: '${detail.params.additionalProperty}')${detail.line ? " (line " + detail.line + ")" : ""}`,
              );
            } else {
              console.error(
                `  - ${detail.message}${detail.line ? " (line " + detail.line + ")" : ""}`,
              );
            }
          }
        } else {
          console.error(err);
        }
      }
    }
  }

  // Validate applications - only search in localPath and jsonPath (like webapp.mts)
  console.log("\nValidating applications...");
  const applicationFiles: string[] = [];
  
  // Search in localPath
  if (fs.existsSync(localPath)) {
    const localApps = findApplicationFiles(
      path.join(localPath, "applications")
    );
    applicationFiles.push(...localApps);
  }
  
  // Search in jsonPath
  if (fs.existsSync(jsonPath)) {
    const jsonApps = findApplicationFiles(
      path.join(jsonPath, "applications")
    );
    applicationFiles.push(...jsonApps);
  }
  
  const applicationSchemaPath = path.join(schemasDir, "application.schema.json");

  for (const filePath of applicationFiles) {
    // Calculate relative path from the base (localPath or jsonPath)
    const relPath = path.relative(
      filePath.startsWith(localPath) ? localPath : jsonPath,
      filePath
    );
    try {
      validator.serializeJsonFileWithSchema(filePath, applicationSchemaPath);
      console.log(`✔ Valid application: ${relPath}`);
    } catch (err: any) {
      hasError = true;
      const schemaName = path.basename(applicationSchemaPath);
      console.error(`✖ Invalid application: ${relPath} [${schemaName}]`);
      if (err && err.details) {
        for (const detail of err.details) {
          const isAdditional =
            detail.message &&
            detail.message.includes("must NOT have additional properties");
          if (
            isAdditional &&
            detail.params &&
            detail.params.additionalProperty
          ) {
            console.error(
              `  - ${detail.message} (property: '${detail.params.additionalProperty}')${detail.line ? " (line " + detail.line + ")" : ""}`,
            );
          } else {
            console.error(
              `  - ${detail.message}${detail.line ? " (line " + detail.line + ")" : ""}`,
            );
          }
        }
      } else {
        console.error(err);
      }
    }
  }

  // Validate scripts and templates referenced in applications
  console.log("\nValidating scripts and templates in applications...");
  
  // Initialize StorageContext for template processing
  // Use the same localPath as above (already defined)
  const storageContextPath = path.join(localPath, "storagecontext.json");
  const secretFilePath = path.join(localPath, "secret.txt");
  
  // Create minimal storage context if it doesn't exist
  if (!fs.existsSync(storageContextPath)) {
    fs.mkdirSync(path.dirname(storageContextPath), { recursive: true });
    fs.writeFileSync(storageContextPath, JSON.stringify({ veContexts: [] }, null, 2));
  }
  if (!fs.existsSync(secretFilePath)) {
    fs.mkdirSync(path.dirname(secretFilePath), { recursive: true });
    fs.writeFileSync(secretFilePath, "dummy-secret-for-validation");
  }
  
  StorageContext.setInstance(localPath, storageContextPath, secretFilePath);
  const storageContext = StorageContext.getInstance();
  const templateProcessor = storageContext.getTemplateProcessor();
  
  // Get pathes from storageContext (similar to how it's done in lxc-exec.mts)
  // Use the same paths as webapp.mts
  const configuredPathes = {
    schemaPath: schemasDir,
    jsonPath: jsonPath,
    localPath: localPath,
  };
  const appLoader = new ApplicationLoader(configuredPathes);
  
  const VALID_TASK_TYPES: TaskType[] = [
    "installation",
    "backup",
    "restore",
    "uninstall",
    "update",
    "upgrade",
    "webui",
  ];
  
  // Process each application
  for (const filePath of applicationFiles) {
    // Calculate relative path from the base (localPath or jsonPath)
    const relPath = path.relative(
      filePath.startsWith(localPath) ? localPath : jsonPath,
      filePath
    );
    const appDir = path.dirname(filePath);
    const appName = path.basename(appDir);
    
    try {
      // Read application.json to get tasks
      const readOpts: IReadApplicationOptions = {
        applicationHierarchy: [],
        error: new VEConfigurationError("", appName),
        taskTemplates: [],
      };
      
      try {
        appLoader.readApplicationJson(appName, readOpts);
      } catch {
        // Application.json might have errors, but we continue to check templates
        if (readOpts.error.details && readOpts.error.details.length > 0) {
          hasError = true;
          console.error(`✖ Error loading application: ${relPath}`);
          for (const detail of readOpts.error.details) {
            console.error(`  - ${detail.message || detail}`);
          }
          continue;
        }
      }
      
      // Process each task
      for (const taskEntry of readOpts.taskTemplates) {
        const task = taskEntry.task as TaskType;
        if (!VALID_TASK_TYPES.includes(task)) {
          continue; // Skip invalid task types
        }
        
        try {
          // Create a minimal VE context for validation if none exists
          // We need at least one VE context to use loadApplication
          let veContext = storageContext.getCurrentVEContext();
          
          // If no current VE context, try to find any VE context
          if (!veContext) {
            const veKeys = storageContext.keys().filter((k) => k.startsWith("ve_"));
            if (veKeys.length > 0 && veKeys[0]) {
              veContext = storageContext.getVEContextByKey(veKeys[0]);
            }
          }
          
          // If no VE context exists, create a minimal one for validation
          if (!veContext) {
            const dummyVeContext = {
              host: "dummy-host-for-validation",
              port: 22,
              current: true,
              getStorageContext: () => storageContext,
              getKey: () => "dummy-validation-key",
            } as IVEContext;
            storageContext.setVEContext(dummyVeContext);
            veContext = storageContext.getVEContextByKey("ve_dummy-host-for-validation");
          }
          
          // Use the normal loadApplication which validates everything (templates, scripts, etc.)
          if (veContext) {
            await templateProcessor.loadApplication(appName, task, veContext);
            console.log(`✔ Validated application: ${relPath} (task: ${task})`);
          } else {
            // Fallback: manually check templates if VE context creation failed
            // Build template and script paths
            const templatePathes = TemplatePathResolver.buildTemplatePathes(
              readOpts.applicationHierarchy,
              { jsonPath, localPath, schemaPath: schemasDir },
            );
            
            // Check each template exists
            for (const tmpl of taskEntry.templates) {
              const tmplName = typeof tmpl === "string" ? tmpl : tmpl.name;
              const tmplFound = TemplatePathResolver.findInPathes(templatePathes, tmplName) !== undefined;
              if (!tmplFound) {
                hasError = true;
                console.error(`✖ Template not found: ${tmplName} (in application ${appName}, task ${task})`);
                console.error(`  Searched in: ${templatePathes.join(", ")}`);
              }
            }
          }
        } catch (err: any) {
          hasError = true;
          console.error(`✖ Error validating application: ${relPath} (task: ${task})`);
          
          if (err instanceof VEConfigurationError || err instanceof VELoadApplicationError) {
            if (err.details && Array.isArray(err.details)) {
              for (const detail of err.details) {
                if (detail && typeof detail === "object" && "message" in detail) {
                  console.error(`  - ${detail.message}`);
                } else {
                  console.error(`  - ${String(detail)}`);
                }
              }
            } else if (err.message) {
              console.error(`  - ${err.message}`);
            }
          } else if (err instanceof Error) {
            console.error(`  - ${err.message}`);
          } else {
            console.error(`  - ${String(err)}`);
          }
        }
      }
    } catch (err: any) {
      hasError = true;
      console.error(`✖ Error processing application: ${relPath}`);
      console.error(`  - ${err.message || String(err)}`);
    }
  }

  if (hasError) {
    console.error("\nValidation failed. Please fix the errors above.");
    process.exit(1);
  } else {
    console.log("\nAll templates, applications, scripts, and referenced templates are valid.");
  }
}

