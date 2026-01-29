import { IRestartInfo, VeExecution } from "./ve-execution/ve-execution.mjs";
// Make sure the types file exists, or update the path if necessary
// If your types are in a TypeScript file, use './types' instead of './types.js'
import type { TaskType, IVeExecuteMessage } from "./types.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonError } from "./jsonvalidator.mjs";
import { TemplateProcessor } from "@src/templates/templateprocessor.mjs";
import { promises, writeFileSync } from "node:fs";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";
function printUsageAndExit() {
  console.error(
    "Usage: lxc-exec <application> <task> <parameters.json> [--local <path>] [--secretsFilePath <path>] [--restartInfoFile <path>]",
  );
}
function saveRestartInfo(
  restartInfo: IRestartInfo | undefined,
  restartInfoArg: string | undefined,
) {
  if (restartInfoArg && restartInfo) {
    console.error("Saving restart info to ", restartInfoArg);
    try {
      const data = JSON.stringify(restartInfo, null, 2);
      promises.writeFile(restartInfoArg, data, "utf-8");
      writeFileSync(restartInfoArg, data, "utf-8");
    } catch (e: Error | any) {
      console.error("Failed to save restart info:", e.message);
    }
  }
}

export async function exec(
  application: string,
  task: TaskType,
  paramsFile: string,
  restartInfoFile?: string,
  localPath?: string,
  storageContextFilePath?: string,
  secretsFilePath?: string,
): Promise<void> {
  let restartInfo: IRestartInfo | null = null;

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "..");
    const schemaPath = path.join(projectRoot, "schemas");
    const jsonPath = path.join(projectRoot, "json");
    const resolvedLocalPath = localPath || path.join(projectRoot, "local/json");
    const resolvedStorageContextFilePath =
      storageContextFilePath ||
      path.join(resolvedLocalPath, "storagecontext.json");
    const resolvedSecretFilePath =
      secretsFilePath || path.join(resolvedLocalPath, "secret.txt");
    JsonError.baseDir = projectRoot;
    // Close existing instance if any
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
    PersistenceManager.initialize(
      resolvedLocalPath,
      resolvedStorageContextFilePath,
      resolvedSecretFilePath,
    );
    // Get all apps (name -> path)
    const allApps = PersistenceManager.getInstance().getApplicationService().getAllAppNames();
    const appPath = allApps.get(application);
    if (!appPath) {
      console.error(
        `Application '${application}' not found. Available: ${Array.from(allApps.keys()).join(", ")}`,
      );
      process.exit(2);
    }

    const pm = PersistenceManager.getInstance();
    const cm = pm.getContextManager();
    const templateProcessor = new TemplateProcessor({
      schemaPath,
      jsonPath,
      localPath: resolvedLocalPath,
    }, cm, pm.getPersistence());

    if (!paramsFile) {
      const veContext = PersistenceManager.getInstance().getContextManager().getCurrentVEContext();
      if (!veContext) {
        console.error(
          "VE context not set. Please configure SSH host/port first.",
        );
        process.exit(2);
      }
      const unresolved = await templateProcessor.getUnresolvedParameters(
        application,
        task,
        veContext,
      );
      const requiredNames = unresolved
        .filter((param: any) => param.default === undefined)
        .map((param: any) => param.name);
      printUsageAndExit();
      console.error(
        "Fill the value fields and paste the following as your parameters.json:",
      );
      const paramTemplate = requiredNames.map((name: string) => ({
        name,
        value: "",
      }));
      console.error(JSON.stringify(paramTemplate, null, 2));
      return;
    }
    if (restartInfoFile) {
      try {
        restartInfo = JSON.parse(readFileSync(restartInfoFile, "utf-8"));
      } catch (e: Error | any) {
        console.error(
          "Failed to get restartInfo. Start from the beginning",
          e.message,
        );
      }
    }
    const veContext = cm.getCurrentVEContext();
    if (!veContext) {
      console.error(
        "VE context not set. Please configure SSH host/port first.",
      );
      process.exit(2);
    }
    const loaded = await templateProcessor.loadApplication(
      application,
      task,
      veContext,
    );
    const params = JSON.parse(readFileSync(paramsFile!, "utf-8"));
    if (!Array.isArray(params)) {
      throw new Error(
        "Parameters file must be a JSON array of {name, value} objects",
      );
    }
    const defaults = new Map();
    loaded.parameters.forEach((param) => {
      if (param.default !== undefined) {
        defaults.set(param.name, param.default);
      }
    });
    const execInstance = new VeExecution(
      loaded.commands,
      params,
      cm.getCurrentVEContext(),
      defaults,
    );
    execInstance.on("message", (msg: IVeExecuteMessage) => {
      console.error(`[${msg.command}] ${msg.stderr}`);
      if (msg.exitCode !== 0) {
        console.log("=================== ERROR ==================");
        console.log("=================== Command: ==================");
        console.error(`[${msg.commandtext}] ${msg.stderr}`);
      }
    });
    const rcRestartInfo = await execInstance.run(restartInfo);
    if (rcRestartInfo) saveRestartInfo(rcRestartInfo, restartInfoFile);
    console.log("All tasks completed successfully.");
  } catch (err) {
    if (err instanceof JsonError) {
      console.error("Error:", err.message);
      // Print details if this is a JsonError
      if (err.details && err.details.length > 0) {
        console.error("Details:");
        printDetails(err.details);
      } else {
        console.error("Error:", err);
      }
      throw err;
    }
    if (err instanceof Error) {
      console.error("Error:", err.message);
    } else {
      console.error("Error:", err);
    }
    throw err;
  }
}
function printDetails(details: any[], level = 1) {
  const indent = "  ".repeat(level);
  for (const detail of details) {
    if (detail && typeof detail === "object") {
      if (
        "error" in detail &&
        detail.error &&
        typeof detail.error.message === "string"
      ) {
        const line = detail.line !== undefined ? ` (line: ${detail.line})` : "";
        console.error(`${indent}- ${detail.error.message}${line}`);
      }
      if ("details" in detail.error && Array.isArray(detail.error.details)) {
        printDetails(detail.error.details, level + 1);
      }
      // If the object has other properties that are not error/details:
      const keys = Object.keys(detail).filter(
        (k) => k !== "error" && k !== "details" && k !== "line",
      );
      if (keys.length > 0) {
        console.error(`${indent}- ${JSON.stringify(detail, null, 2)}`);
      }
    } else {
      console.error(`${indent}- ${detail}`);
    }
  }
}
