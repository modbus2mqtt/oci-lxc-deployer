import path from "node:path";
import fs from "fs";
import { fileURLToPath } from "url";
import { JsonValidator } from "./jsonvalidator.mjs";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";
import { ApplicationLoader } from "./apploader.mjs";
import { IReadApplicationOptions } from "./backend-types.mjs";
import { TaskType } from "./types.mjs";
import { VEConfigurationError, VELoadApplicationError, IVEContext } from "./backend-types.mjs";
import { TemplateProcessor } from "./templates/templateprocessor.mjs";
import { FileSystemPersistence } from "./persistence/filesystem-persistence.mjs";
import { ExecutionMode } from "./ve-execution/ve-execution-constants.mjs";

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

function findFrameworkFiles(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) {
    return results;
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith(".json")) {
        results.push(fullPath);
      } else if (entry.isDirectory()) {
        results = results.concat(findFrameworkFiles(fullPath));
      }
    }
  } catch {
    // Ignore errors reading directory (e.g., permission denied)
  }
  return results;
}

function findAddonFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) {
    return results;
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // Addons are single JSON files (not in subdirectories)
      if (entry.isFile() && entry.name.endsWith(".json")) {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore errors reading directory (e.g., permission denied)
  }
  return results;
}

export async function validateAllJson(localPathArg?: string): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const projectRoot = path.resolve(__dirname, "..");
  const rootDir = path.resolve(projectRoot, "..");
  const schemasDir = path.join(rootDir, "schemas");
  
  // Use the same paths as webapp.mts: localPath and jsonPath
  // Default localPath is "examples" in root directory (same as webapp.mts)
  // Priority: 1. localPathArg (from --local option), 2. LXC_MANAGER_LOCAL_PATH env var, 3. default "examples"
  const defaultLocalPath = path.join(rootDir, "examples");
  let localPath: string;
  if (localPathArg) {
    // If localPathArg is relative, make it relative to process.cwd(), otherwise use as-is
    localPath = path.isAbsolute(localPathArg) ? localPathArg : path.join(process.cwd(), localPathArg);
  } else {
    localPath = process.env.LXC_MANAGER_LOCAL_PATH || defaultLocalPath;
  }
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

  // Validate templates - search in localPath (default: examples) and jsonPath
  console.log("Validating templates...");
  const templateDirs: string[] = [];
  
  // Search in localPath (default: examples)
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

  // Validate applications - search in localPath (default: examples) and jsonPath
  console.log("\nValidating applications...");
  const applicationFiles: string[] = [];
  
  // Search in localPath (default: examples)
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

  // Validate frameworks - search in localPath (default: examples) and jsonPath
  console.log("\nValidating frameworks...");
  const frameworkFiles: string[] = [];

  // Search in localPath (default: examples)
  if (fs.existsSync(localPath)) {
    const localFrameworks = findFrameworkFiles(
      path.join(localPath, "frameworks"),
    );
    frameworkFiles.push(...localFrameworks);
  }

  // Search in jsonPath
  if (fs.existsSync(jsonPath)) {
    const jsonFrameworks = findFrameworkFiles(
      path.join(jsonPath, "frameworks"),
    );
    frameworkFiles.push(...jsonFrameworks);
  }

  const frameworkSchemaPath = path.join(schemasDir, "framework.schema.json");

  for (const filePath of frameworkFiles) {
    const relPath = path.relative(
      filePath.startsWith(localPath) ? localPath : jsonPath,
      filePath,
    );
    try {
      validator.serializeJsonFileWithSchema(filePath, frameworkSchemaPath);
      console.log(`✔ Valid framework: ${relPath}`);
    } catch (err: any) {
      hasError = true;
      const schemaName = path.basename(frameworkSchemaPath);
      console.error(`✖ Invalid framework: ${relPath} [${schemaName}]`);
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
              `  - ${detail.message} (property: '${detail.params.additionalProperty}')${
                detail.line ? " (line " + detail.line + ")" : ""
              }`,
            );
          } else {
            console.error(
              `  - ${detail.message}${
                detail.line ? " (line " + detail.line + ")" : ""
              }`,
            );
          }
        }
      } else {
        console.error(err);
      }
    }
  }

  // Validate addons - search in localPath and jsonPath
  console.log("\nValidating addons...");
  const addonFiles: string[] = [];

  // Search in localPath
  if (fs.existsSync(localPath)) {
    const localAddons = findAddonFiles(path.join(localPath, "addons"));
    addonFiles.push(...localAddons);
  }

  // Search in jsonPath
  if (fs.existsSync(jsonPath)) {
    const jsonAddons = findAddonFiles(path.join(jsonPath, "addons"));
    addonFiles.push(...jsonAddons);
  }

  const addonSchemaPath = path.join(schemasDir, "addon.schema.json");

  for (const filePath of addonFiles) {
    const relPath = path.relative(
      filePath.startsWith(localPath) ? localPath : jsonPath,
      filePath,
    );
    try {
      validator.serializeJsonFileWithSchema(filePath, addonSchemaPath);
      console.log(`✔ Valid addon: ${relPath}`);
    } catch (err: any) {
      hasError = true;
      const schemaName = path.basename(addonSchemaPath);
      console.error(`✖ Invalid addon: ${relPath} [${schemaName}]`);
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
              `  - ${detail.message} (property: '${detail.params.additionalProperty}')${
                detail.line ? " (line " + detail.line + ")" : ""
              }`,
            );
          } else {
            console.error(
              `  - ${detail.message}${
                detail.line ? " (line " + detail.line + ")" : ""
              }`,
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
  
  // Initialize PersistenceManager for template processing
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
  
  // Close existing instance if any
  try {
    PersistenceManager.getInstance().close();
  } catch {
    // Ignore if not initialized
  }
  PersistenceManager.initialize(localPath, storageContextPath, secretFilePath);
  const pm = PersistenceManager.getInstance();
  const storageContext = pm.getContextManager();
  
  // Get pathes from PersistenceManager (similar to how it's done in lxc-exec.mts)
  // Use the same paths as webapp.mts
  const configuredPathes = {
    schemaPath: schemasDir,
    jsonPath: jsonPath,
    localPath: localPath,
  };
  const persistence = new FileSystemPersistence(
    configuredPathes,
    pm.getJsonValidator(),
  );
  const appLoader = new ApplicationLoader(configuredPathes, persistence);
  
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
          // Create a dummy VE context for validation
          // loadApplication requires a VE context, but we don't need a real SSH connection
          // The VE context is only used for path resolution, not for SSH operations
          const dummyVeContext: IVEContext = {
            host: "validation-dummy",
            current: false,
            getStorageContext: () => storageContext,
            getKey: () => "ve_validation-dummy",
          };
          
          // Use loadApplication to validate the application
          // This will perform full template processing including:
          // - Schema validation
          // - Template existence checks
          // - Script existence checks
          // - Duplicate output/property ID checks
          // - Skip logic validation
          // Pass ExecutionMode.TEST to skip actual SSH execution for enum templates
          const templateProcessor = new TemplateProcessor(configuredPathes, storageContext, pm.getPersistence());
          await templateProcessor.loadApplication(appName, task, dummyVeContext, ExecutionMode.TEST);
          
          console.log(`✔ Validated application: ${relPath} (task: ${task})`);
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
    process.exit(0);
  }
}

