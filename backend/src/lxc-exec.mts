#!/usr/bin/env node
import { ProxmoxConfiguration } from "./proxmoxconfiguration.mjs";
import { IRestartInfo, ProxmoxExecution } from "./proxmox-execution.mjs";
// Make sure the types file exists, or update the path if necessary
// If your types are in a TypeScript file, use './types' instead of './types.js'
import type { TaskType } from "./types.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonError } from "./jsonvalidator.mjs";
import { TemplateProcessor } from "@src/templateprocessor.mjs";
import { promises, writeFileSync } from "node:fs";
function printUsageAndExit() {
  console.error("Usage: lxc-exec <application> <task> <parameters.json>");
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
function printUnresolvedParameters(
  application: string,
  task: TaskType,
  config: ProxmoxConfiguration,
) {
  printUsageAndExit();
  // The following code will not be reached, but kept for clarity if refactored
  try {
    const templateProcessor = new TemplateProcessor(config);
    const loaded = templateProcessor.loadApplication(application, task);
    const unresolved = templateProcessor.getUnresolvedParameters(
      loaded.parameters,
      loaded.resolvedParams,
    );
    const requiredNames = unresolved
      .filter((param: any) => param.default === undefined)
      .map((param: any) => param.name);
    console.error("Required Parameters:");
    requiredNames.forEach((name: string) => console.error(name));
    process.exit(0);
  } catch (err) {
    if (err instanceof Error) {
      console.error("Error:", err.message);
      // Print details if this is a JsonError
      if ("details" in err && Array.isArray((err as any).details)) {
        console.error("Details:");
        for (const detail of (err as any).details) {
          if (typeof detail === "object" && detail !== null) {
            const { message, line, column, instancePath, schemaPath } = detail;
            console.error(
              `- ${message} (line: ${line}, column: ${column}, instancePath: ${instancePath}, schemaPath: ${schemaPath})`,
            );
          } else {
            console.error(`- ${detail}`);
          }
        }
      }
    } else {
      console.error("Error:", err);
    }
    process.exit(2);
  }
}

async function main() {
  const [, , applicationArg, taskArg, paramsFileArg, restartInfoArg] =
    process.argv;
  if (!applicationArg || !taskArg) {
    printUsageAndExit();
    process.exit(1);
  }
  const application = String(applicationArg);
  const task = String(taskArg) as TaskType;
  const paramsFile = paramsFileArg ? String(paramsFileArg) : undefined;
  let restartInfo: IRestartInfo | null = null;

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const projectRoot = path.resolve(__dirname, "..");
    const schemaPath = path.join(projectRoot, "schemas");
    const jsonPath = path.join(projectRoot, "json");
    const localPath = path.join(projectRoot, "local/json");
    JsonError.baseDir = projectRoot;

    // Hole alle Apps (Name -> Pfad)
    const allApps = ProxmoxConfiguration.getAllApps(jsonPath, localPath);
    const appPath = allApps.get(application);
    if (!appPath) {
      console.error(
        `Application '${application}' not found. Available: ${Array.from(allApps.keys()).join(", ")}`,
      );
      process.exit(2);
    }

    const config = new ProxmoxConfiguration(schemaPath, jsonPath, localPath);
    const templateProcessor = new TemplateProcessor({
      schemaPath,
      jsonPath,
      localPath,
    });

    if (!paramsFile) {
      const result = templateProcessor.loadApplication(application, task);
      const unresolved = templateProcessor.getUnresolvedParameters(
        result.parameters,
        result.resolvedParams,
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
      process.exit(0);
    }
    if (restartInfoArg) {
      try {
        restartInfo = JSON.parse(readFileSync(restartInfoArg, "utf-8"));
      } catch (e: Error | any) {
        console.error(
          "Failed to get restartInfo. Start from the beginning",
          e.message,
        );
      }
    }
    const loaded = templateProcessor.loadApplication(application, task);
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
    const exec = new ProxmoxExecution(loaded.commands, params, defaults);
    exec.on("message", (msg) => {
      console.error(`[${msg.command}] ${msg.stderr}`);
      if (msg.exitCode !== 0) {
        console.log("=================== ERROR ==================");
        console.log("=================== Command: ==================");
        console.error(`[${msg.commandtext}] ${msg.stderr}`);
      }
    });
    const rcRestartInfo = exec.run(restartInfo);
    saveRestartInfo(rcRestartInfo, restartInfoArg);
    console.log("All tasks completed successfully.");
    process.exit(0);
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
      process.exit(2);
    }
    if (err instanceof Error) {
      console.error("Error:", err.message);
    } else {
      console.error("Error:", err);
    }
    process.exit(2);
    
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
      // Falls das Objekt noch weitere Properties hat, die nicht error/details sind:
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
function listDetails(err: JsonError) {
  if (err.details && Array.isArray(err.details)) {
    for (const detail of err.details) {
      if ((detail as any).details && err.details.length > 0) {
        listDetails(detail as any);
      } else {
        console.error(
          `- ${detail.message} ` +
            (detail.line ? `(line: ${detail.line})` : ""),
        );
      }
    }
  }
}

main();
