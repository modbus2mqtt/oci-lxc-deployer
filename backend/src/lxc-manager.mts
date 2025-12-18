#!/usr/bin/env node
import path from "node:path";
import { StorageContext } from "./storagecontext.mjs";
import { VEWebApp } from "./webapp.mjs";
import { exec as execCommand } from "./lxc-exec.mjs";
import type { TaskType } from "./types.mjs";

interface ParsedArgs {
  command?: string;
  localPath?: string;
  secretsFilePath?: string;
  parametersFile?: string;
  restartInfoFile?: string;
  application?: string;
  task?: string;
}

function parseArgs(): ParsedArgs {
  const args: ParsedArgs = {};
  const argv = process.argv.slice(2);
  
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg) {
      i += 1;
      continue;
    }
    
    if (arg === "--local") {
      const value = argv[i + 1];
      if (value && !value.startsWith("--")) {
        args.localPath = path.isAbsolute(value)
          ? value
          : path.join(process.cwd(), value);
        i += 2;
      } else {
        // --local ohne Wert bedeutet "local"
        args.localPath = path.join(process.cwd(), "local");
        i += 1;
      }
    } else if (arg === "--secretsFilePath") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        console.error("--secretsFilePath requires a value");
        process.exit(1);
      }
      args.secretsFilePath = path.isAbsolute(value)
        ? value
        : path.join(process.cwd(), value);
      i += 2;
    } else if (arg === "--restartInfoFile") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        console.error("--restartInfoFile requires a value");
        process.exit(1);
      }
      args.restartInfoFile = path.isAbsolute(value)
        ? value
        : path.join(process.cwd(), value);
      i += 2;
    } else if (!args.command && !arg.startsWith("--")) {
      // First non-option argument is the command
      args.command = arg;
      i += 1;
    } else if (args.command === "exec") {
      // For exec command, the remaining non-option arguments are application, task, parametersFile
      if (!args.application) {
        args.application = arg;
        i += 1;
      } else if (!args.task) {
        args.task = arg;
        i += 1;
      } else if (!args.parametersFile && !arg.startsWith("--")) {
        const paramFile = path.isAbsolute(arg)
          ? arg
          : path.join(process.cwd(), arg);
        args.parametersFile = paramFile;
        i += 1;
      } else {
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  
  return args;
}

const VALID_TASK_TYPES: TaskType[] = [
  "installation",
  "backup",
  "restore",
  "uninstall",
  "update",
  "upgrade",
  "webui",
];

function isValidTaskType(task: string): task is TaskType {
  return VALID_TASK_TYPES.includes(task as TaskType);
}

async function startWebApp(localPath: string, secretsFilePath?: string) {
  StorageContext.setInstance(localPath, secretsFilePath);
  const webApp = new VEWebApp(StorageContext.getInstance());
  const port = process.env.PORT || 3000;
  webApp.httpServer.listen(port, () => {
    console.log(`VEWebApp listening on port ${port}`);
  });
}

async function runExecCommand(
  application: string,
  task: TaskType,
  parametersFile: string,
  localPath?: string,
  secretsFilePath?: string,
  restartInfoFile?: string,
) {
  await execCommand(
    application,
    task,
    parametersFile,
    restartInfoFile,
    localPath,
    secretsFilePath,
  );
}

function printHelp() {
  console.log("LXC Manager - Manage LXC containers and applications");
  console.log("");
  console.log("Usage:");
  console.log("  lxc-manager [command] [options]");
  console.log("");
  console.log("Commands:");
  console.log("  exec <application> <task> <parameters file>");
  console.log("    Execute a task for a specific application in an LXC container");
  console.log("");
  console.log("  (no command)");
  console.log("    Start the web application server");
  console.log("");
  console.log("Options:");
  console.log("  --local <path>              Path to the local data directory");
  console.log("                             For exec: default is 'local' in current working directory");
  console.log("                             For web app: default is 'examples' in current working directory");
  console.log("                             If --local is specified without a value, uses 'local'");
  console.log("  --secretsFilePath <path>   Path to the secrets file for encryption/decryption");
  console.log("  --restartInfoFile <path>   Path to the restart info JSON file (exec command only)");
  console.log("  --help, -h                 Show this help message");
  console.log("");
  console.log("Task Types (for exec command):");
  VALID_TASK_TYPES.forEach(task => {
    console.log(`  ${task}`);
  });
  console.log("");
  console.log("Examples:");
  console.log("  # Start web application");
  console.log("  lxc-manager");
  console.log("  lxc-manager --local ./my-local");
  console.log("");
  console.log("  # Execute installation task");
  console.log("  lxc-manager exec node-red installation ./params.json");
  console.log("  lxc-manager exec node-red installation ./params.json --local ./my-local");
  console.log("");
  console.log("  # Execute backup task with secrets");
  console.log("  lxc-manager exec node-red backup ./backup-params.json --secretsFilePath ./secrets.txt");
}

async function main() {
  const argv = process.argv.slice(2);
  
  // Check for help flag
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  
  const args = parseArgs();
  
  // If no command, start webapp
  if (!args.command) {
    const localPath = args.localPath || path.join(process.cwd(), "examples");
    await startWebApp(localPath, args.secretsFilePath);
    return;
  }
  
  // Handle commands
  if (args.command === "exec") {
    if (!args.application || !args.task || !args.parametersFile) {
      console.error("Usage: lxc-manager exec <application> <task> <parameters file> [options]");
      console.error("");
      console.error("Command: exec");
      console.error("  Execute a task for a specific application in an LXC container.");
      console.error("");
      console.error("Arguments:");
      console.error("  <application>     Name of the application to execute the task for");
      console.error("  <task>            Task type to execute. Valid values:");
      VALID_TASK_TYPES.forEach(task => {
        console.error(`                     - ${task}`);
      });
      console.error("  <parameters file> Path to the JSON file containing task parameters");
      console.error("");
      console.error("Options:");
      console.error("  --local <path>              Path to the local data directory");
      console.error("                             (default: 'local' in current working directory)");
      console.error("                             If --local is specified without a value, uses 'local'");
      console.error("  --secretsFilePath <path>   Path to the secrets file for encryption/decryption");
      console.error("  --restartInfoFile <path>   Path to the restart info JSON file");
      console.error("");
      console.error("Examples:");
      console.error("  lxc-manager exec node-red installation ./params.json");
      console.error("  lxc-manager exec node-red installation ./params.json --local ./my-local");
      console.error("  lxc-manager exec node-red backup ./backup-params.json --secretsFilePath ./secrets.txt");
      process.exit(1);
    }
    if (!isValidTaskType(args.task)) {
      console.error(
        `Invalid task type: ${args.task}. Valid values are: ${VALID_TASK_TYPES.join(", ")}`,
      );
      process.exit(1);
    }
    await runExecCommand(
      args.application,
      args.task,
      args.parametersFile,
      args.localPath,
      args.secretsFilePath,
      args.restartInfoFile,
    );
  } else {
    console.error(`Unknown command: ${args.command}`);
    console.error("");
    console.error("Available commands:");
    console.error("  exec    Execute a task for a specific application");
    console.error("");
    console.error("Usage (start web app):");
    console.error("  lxc-manager [options]");
    console.error("");
    console.error("Options:");
    console.error("  --local <path>            Path to the local data directory");
    console.error("                           (default: 'examples' in current working directory)");
    console.error("  --secretsFilePath <path> Path to the secrets file for encryption/decryption");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
