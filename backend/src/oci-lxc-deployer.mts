#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";
import { exec as execCommand } from "./lxc-exec.mjs";
import { validateAllJson, ValidationError } from "./validateAllJson.mjs";
import { DocumentationGenerator } from "./documentation-generator.mjs";
import { VEWebApp } from "./webapp/webapp.mjs";
import type { TaskType } from "./types.mjs";

interface ParsedArgs {
  command?: string;
  localPath?: string;
  storageContextFilePath?: string;
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
    } else if (arg === "--storageContextFilePath") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        console.error("--storageContextFilePath requires a value");
        process.exit(1);
      }
      args.storageContextFilePath = path.isAbsolute(value)
        ? value
        : path.join(process.cwd(), value);
      i += 2;
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
    } else if (args.command === "updatedoc") {
      // For updatedoc command, optional application name
      if (!args.application && !arg.startsWith("--")) {
        args.application = arg;
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

async function startWebApp(
  localPath: string,
  storageContextPath: string,
  secretFilePath: string,
) {
  PersistenceManager.initialize(localPath, storageContextPath, secretFilePath);
  const pm = PersistenceManager.getInstance();
  // Ensure SSH public key exists early so installer can import it
  try {
    const { Ssh } = await import("./ssh.mjs");
    const pub = (Ssh as any).getPublicKey?.();
    if (pub && typeof pub === "string" && pub.length > 0) {
      console.log("SSH public key ready for import");
    } else {
      console.log("SSH public key not available yet; will be generated on demand");
    }
  } catch {}
  const webApp = new VEWebApp(pm.getContextManager());
  const port = process.env.PORT || 3000;
  webApp.httpServer.listen(port, () => {
    console.log(`VEWebApp listening on port ${port}`);
  });

  // Graceful shutdown handlers
  const shutdown = (signal: string) => {
    console.log(`\n${signal} received, shutting down gracefully...`);
    webApp.httpServer.close(() => {
      console.log("HTTP server closed");
      process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
      console.error("Forced shutdown after timeout");
      process.exit(1);
    }, 10000);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function runExecCommand(
  application: string,
  task: TaskType,
  parametersFile: string,
  localPath?: string,
  storageContextFilePath?: string,
  secretsFilePath?: string,
  restartInfoFile?: string,
) {
  // Set default values for optional parameters
  const resolvedLocalPath = localPath || path.join(process.cwd(), "local");
  const resolvedStorageContextFilePath =
    storageContextFilePath ||
    path.join(resolvedLocalPath, "storagecontext.json");
  const resolvedSecretFilePath =
    secretsFilePath || path.join(resolvedLocalPath, "secret.txt");

  await execCommand(
    application,
    task,
    parametersFile,
    restartInfoFile,
    resolvedLocalPath,
    resolvedStorageContextFilePath,
    resolvedSecretFilePath,
  );
}

async function runValidateCommand(localPath?: string) {
  try {
    await validateAllJson(localPath);
    process.exit(0);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.exit(1);
    }
    throw err;
  }
}

async function runUpdatedocCommand(applicationName?: string, localPathArg?: string) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  // projectRoot should be the workspace root, not backend root
  // From backend/dist, go up to backend, then up to workspace root
  const backendRoot = path.resolve(__dirname, "..");
  const projectRoot = path.resolve(backendRoot, "..");
  const schemaPath = path.join(projectRoot, "schemas");
  const jsonPath = path.join(projectRoot, "json");
  const localPath = localPathArg || path.join(projectRoot, "local", "json");

  // Validate all JSON files before generating documentation
  // If validation fails, exit and documentation won't be generated
  console.log("Validating all JSON files before generating documentation...\n");
  try {
    await validateAllJson(localPathArg);
  } catch (err) {
    if (err instanceof ValidationError) {
      process.exit(1);
    }
    throw err;
  }
  console.log("\n✓ Validation successful. Proceeding with documentation generation...\n");

  // Initialize PersistenceManager
  PersistenceManager.initialize(
    localPath,
    path.join(localPath, "storagecontext.json"),
    path.join(localPath, "secret.txt"),
  );

  const generator = new DocumentationGenerator(jsonPath, localPath, schemaPath);
  await generator.generateDocumentation(applicationName);
  console.log("\n✓ Documentation generation completed!");
}

function printHelp() {
  console.log("OCI LXC Deployer - Manage LXC containers and applications");
  console.log("");
  console.log("Usage:");
  console.log("  oci-lxc-deployer [command] [options]");
  console.log("");
  console.log("Commands:");
  console.log("  exec <application> <task> <parameters file>");
  console.log(
    "    Execute a task for a specific application in an LXC container",
  );
  console.log("");
  console.log("  validate");
  console.log("    Validate all templates, applications and frameworks against their schemas");
  console.log("");
  console.log("  updatedoc [application]");
  console.log("    Generate or update documentation for applications and templates");
  console.log("    If application is specified, only that application is documented");
  console.log("");
  console.log("  (no command)");
  console.log("    Start the web application server");
  console.log("");
  console.log("Options:");
  console.log(
    "  --local <path>                    Path to the local data directory",
  );
  console.log(
    "                                   For exec: default is 'local' in current working directory",
  );
  console.log(
    "                                   For web app: default is 'examples' in current working directory",
  );
  console.log(
    "                                   If --local is specified without a value, uses 'local'",
  );
  console.log(
    "  --storageContextFilePath <path>   Path to the storage context file (storagecontext.json)",
  );
  console.log(
    "                                   Default: <localPath>/storagecontext.json",
  );
  console.log(
    "  --secretsFilePath <path>          Path to the secrets file for encryption/decryption",
  );
  console.log(
    "                                   Default: <localPath>/secret.txt",
  );
  console.log(
    "  --restartInfoFile <path>          Path to the restart info JSON file (exec command only)",
  );
  console.log("  --help, -h                       Show this help message");
  console.log("");
  console.log("Task Types (for exec command):");
  VALID_TASK_TYPES.forEach((task) => {
    console.log(`  ${task}`);
  });
  console.log("");
  console.log("Examples:");
  console.log("  # Start web application");
  console.log("  oci-lxc-deployer");
  console.log("  oci-lxc-deployer --local ./my-local");
  console.log("");
  console.log("  # Validate templates and applications");
  console.log("  oci-lxc-deployer validate");
  console.log("");
  console.log("  # Execute installation task");
  console.log("  oci-lxc-deployer exec node-red installation ./params.json");
  console.log(
    "  oci-lxc-deployer exec node-red installation ./params.json --local ./my-local",
  );
  console.log("");
  console.log("  # Execute backup task with secrets");
  console.log(
    "  oci-lxc-deployer exec node-red backup ./backup-params.json --secretsFilePath ./secrets.txt",
  );
}

async function main() {
  try {
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
      const storageContextFilePath =
        args.storageContextFilePath ||
        path.join(localPath, "storagecontext.json");
      const secretFilePath =
        args.secretsFilePath || path.join(localPath, "secret.txt");
      await startWebApp(localPath, storageContextFilePath, secretFilePath);
      return;
    }

    // Handle commands
    if (args.command === "validate") {
      const localPath = args.localPath || path.join(process.cwd(), "examples");
      await runValidateCommand(localPath);
      return;
    } else if (args.command === "updatedoc") {
      const localPath = args.localPath || path.join(process.cwd(), "examples");
      await runUpdatedocCommand(args.application, localPath);
      return;
    } else if (args.command === "exec") {
      if (!args.application || !args.task || !args.parametersFile) {
        console.error(
          "Usage: oci-lxc-deployer exec <application> <task> <parameters file> [options]",
        );
        console.error("");
        console.error("Command: exec");
        console.error(
          "  Execute a task for a specific application in an LXC container.",
        );
        console.error("");
        console.error("Arguments:");
        console.error(
          "  <application>     Name of the application to execute the task for",
        );
        console.error(
          "  <task>            Task type to execute. Valid values:",
        );
        VALID_TASK_TYPES.forEach((task) => {
          console.error(`                     - ${task}`);
        });
        console.error(
          "  <parameters file> Path to the JSON file containing task parameters",
        );
        console.error("");
        console.error("Options:");
        console.error(
          "  --local <path>                    Path to the local data directory",
        );
        console.error(
          "                                   (default: 'local' in current working directory)",
        );
        console.error(
          "                                   If --local is specified without a value, uses 'local'",
        );
        console.error(
          "  --storageContextFilePath <path>   Path to the storage context file (storagecontext.json)",
        );
        console.error(
          "                                   (default: <localPath>/storagecontext.json)",
        );
        console.error(
          "  --secretsFilePath <path>          Path to the secrets file for encryption/decryption",
        );
        console.error(
          "                                   (default: <localPath>/secret.txt)",
        );
        console.error(
          "  --restartInfoFile <path>          Path to the restart info JSON file",
        );
        console.error("");
        console.error("Examples:");
        console.error("  oci-lxc-deployer exec node-red installation ./params.json");
        console.error(
          "  oci-lxc-deployer exec node-red installation ./params.json --local ./my-local",
        );
        console.error(
          "  oci-lxc-deployer exec node-red backup ./backup-params.json --secretsFilePath ./secrets.txt",
        );
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
        args.storageContextFilePath,
        args.secretsFilePath,
        args.restartInfoFile,
      );
    } else {
      console.error(`Unknown command: ${args.command}`);
      console.error("");
      console.error("Available commands:");
      console.error("  exec      Execute a task for a specific application");
      console.error("  validate  Validate all templates and applications");
      console.error("  updatedoc Generate or update documentation for applications and templates");
      console.error("");
      console.error("Usage (start web app):");
      console.error("  oci-lxc-deployer [options]");
      console.error("");
      console.error("Options:");
      console.error(
        "  --local <path>                    Path to the local data directory",
      );
      console.error(
        "                                   (default: 'examples' in current working directory)",
      );
      console.error(
        "  --storageContextFilePath <path>   Path to the storage context file (storagecontext.json)",
      );
      console.error(
        "                                   (default: <localPath>/storagecontext.json)",
      );
      console.error(
        "  --secretsFilePath <path>          Path to the secrets file for encryption/decryption",
      );
      console.error(
        "                                   (default: <localPath>/secret.txt)",
      );
      process.exit(1);
    }
  } catch (err: any) {
    console.error("Unexpected error:", err?.message || err);
    if (err?.stack) {
      console.error("Stack trace:", err.stack);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Unhandled promise rejection:", err?.message || err);
  if (err?.stack) {
    console.error("Stack trace:", err.stack);
  }
  process.exit(1);
});
