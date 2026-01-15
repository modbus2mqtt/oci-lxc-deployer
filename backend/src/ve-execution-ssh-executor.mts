import { ICommand, IVeExecuteMessage } from "./types.mjs";
import { IVEContext } from "./backend-types.mjs";
import { spawnAsync } from "./spawn-utils.mjs";
import { JsonError } from "./jsonvalidator.mjs";
import { VeExecutionConstants, getNextMessageIndex, ExecutionMode, determineExecutionMode } from "./ve-execution-constants.mjs";
import { VeExecutionMessageEmitter } from "./ve-execution-message-emitter.mjs";
import { OutputProcessor } from "./output-processor.mjs";

export interface SshExecutorDependencies {
  veContext: IVEContext | null;
  sshCommand?: string; // Deprecated: use executionMode instead
  executionMode?: ExecutionMode; // New: preferred way to specify execution mode
  scriptTimeoutMs: number;
  messageEmitter: VeExecutionMessageEmitter;
  outputProcessor: OutputProcessor;
  outputsRaw: { name: string; value: string | number | boolean }[] | undefined;
  setOutputsRaw: (raw: { name: string; value: string | number | boolean }[]) => void;
}

/**
 * Handles SSH/remote command execution for VeExecution.
 */
export class VeExecutionSshExecutor {
  private executionMode: ExecutionMode;
  private sshCommand: string; // Derived from executionMode for backward compatibility

  constructor(private deps: SshExecutorDependencies) {
    // Determine execution mode: prefer explicit executionMode, fallback to sshCommand, then auto-detect
    if (deps.executionMode !== undefined) {
      this.executionMode = deps.executionMode;
    } else if (deps.sshCommand !== undefined) {
      // Backward compatibility: derive from sshCommand
      this.executionMode = deps.sshCommand === "ssh" ? ExecutionMode.PRODUCTION : ExecutionMode.TEST;
    } else if (deps.veContext) {
      // If a VE context is present we almost certainly want to execute on the remote VE host.
      // This prevents running host-specific listing scripts (lsusb/lsblk/...) on the local dev machine.
      // Tests can still force local execution by passing executionMode=TEST.
      this.executionMode = ExecutionMode.PRODUCTION;
    } else {
      // Auto-detect from environment
      this.executionMode = determineExecutionMode();
    }
    // Derive sshCommand for backward compatibility
    this.sshCommand = this.executionMode === ExecutionMode.TEST ? "sh" : "ssh";
  }

  /**
   * Builds execution arguments based on execution mode.
   * In PRODUCTION mode: returns SSH arguments to connect to remote host.
   * In TEST mode: returns local interpreter command (or empty for stdin).
   * @param interpreter Optional interpreter command extracted from shebang (e.g., ["python3"])
   */
  buildExecutionArgs(interpreter?: string[]): string[] {
    if (this.executionMode === ExecutionMode.PRODUCTION) {
      // Production: SSH to remote host
      if (!this.deps.veContext) throw new Error("VE context required for production mode");
      let host = this.deps.veContext.host;
      // Ensure root user is used when no user is specified
      if (typeof host === "string" && !host.includes("@")) {
        host = `root@${host}`;
      }
      const port = this.deps.veContext.port || 22;
      const sshArgs = [
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "BatchMode=yes", // non-interactive: fail if auth requires password
        "-o",
        "PasswordAuthentication=no", // prevent password prompt
        "-o",
        "PreferredAuthentications=publickey", // try keys only
        "-o",
        "LogLevel=ERROR", // suppress login banners and info
        "-o",
        "ServerAliveInterval=30", // send keepalive every 30s
        "-o",
        "ServerAliveCountMax=3", // fail after 3 missed keepalives
        "-T", // disable pseudo-tty to avoid MOTD banners
        "-q", // Suppress SSH diagnostic output
        "-p",
        String(port),
        `${host}`,
      ];
      // Append interpreter if provided (e.g., ssh host python3)
      if (interpreter) {
        sshArgs.push(...interpreter);
      }
      return sshArgs;
    } else {
      // Test mode: execute locally
      // If interpreter specified (from shebang), use it directly
      // Otherwise return empty (will default to sh for stdin execution)
      return interpreter || [];
    }
  }

  /**
   * Builds SSH arguments for connecting to the VE host (backward compatibility).
   * @deprecated Use buildExecutionArgs instead
   */
  buildSshArgs(interpreter?: string[]): string[] {
    return this.buildExecutionArgs(interpreter);
  }

  /**
   * Creates a unique marker to identify where actual output starts (after SSH banners).
   */
  createUniqueMarker(): string {
    return (
      "LXC_MANAGER_JSON_START_MARKER_" +
      Date.now() +
      "_" +
      Math.random().toString(36).slice(2)
    );
  }

  /**
   * Executes a command with retry logic for connection errors.
   * @param executionArgs Arguments for execution (SSH args in production, interpreter args in test)
   * @param input Script content (without marker - marker will be added based on interpreter)
   * @param timeoutMs Timeout in milliseconds
   * @param tmplCommand Template command being executed
   * @param originalInput Original input string (for logging)
   * @param interpreter Optional interpreter extracted from shebang (for test mode)
   * @param uniqueMarker Marker to identify output start
   */
  async executeWithRetry(
    executionArgs: string[],
    input: string,
    timeoutMs: number,
    tmplCommand: ICommand,
    originalInput: string,
    interpreter?: string[],
    uniqueMarker?: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Build marker and determine command structure
    // Strategy: Use "echo 'MARKER' && interpreter" as shell command in TEST mode
    // The script content is passed via stdin, and interpreter will read it
    // This works for all interpreters (Python, Perl, shell, etc.)
    const marker = uniqueMarker || this.createUniqueMarker();
    const maxRetries = VeExecutionConstants.MAX_RETRIES;
    let proc;
    let retryCount = 0;

    // Determine actual command, args, and input to use
    let actualCommand: string;
    let actualArgs: string[];
    let actualInput: string;

    if (this.executionMode === ExecutionMode.PRODUCTION) {
      // Production: use ssh with executionArgs (which contains SSH args + optional interpreter)
      actualCommand = "ssh";
      actualArgs = executionArgs;
      // For production, prepend marker to script for shell scripts
      if (!interpreter || interpreter.length === 0 || !interpreter[0] || interpreter[0] === "sh" || interpreter[0].endsWith("/sh")) {
        actualInput = `echo "${marker}"\n${input}`;
      } else {
        // For non-shell interpreters in production, remote command handles it
        actualInput = input;
      }
    } else {
      // Test mode: use sh -c with "echo 'MARKER' && interpreter" for non-shell interpreters
      if (!interpreter || interpreter.length === 0 || !interpreter[0] || interpreter[0] === "sh" || interpreter[0].endsWith("/sh")) {
        // Shell script: just prepend echo marker
        actualCommand = "sh";
        actualArgs = [];
        actualInput = `echo "${marker}"\n${input}`;
      } else {
        // For non-shell interpreters: use sh -c with "echo 'MARKER' && interpreter"
        // The script content goes via stdin to this command
        // Format: sh -c 'echo "MARKER" && python3' < script.py
        const interpreterCmd = interpreter.join(" ");
        actualCommand = "sh";
        actualArgs = ["-c", `echo "${marker}" && ${interpreterCmd}`];
        // Script content goes via stdin (separate from the -c argument)
        actualInput = input;
      }
    }

    while (retryCount < maxRetries) {
      proc = await spawnAsync(actualCommand, actualArgs, {
        timeout: timeoutMs,
        input: actualInput,
        onStdout: (chunk: string) => {
          // Emit partial message for real-time output (especially useful for hanging scripts)
          this.deps.messageEmitter.emitPartialMessage(tmplCommand, originalInput, chunk, "");
        },
        onStderr: (chunk: string) => {
          // Emit partial message for real-time error output
          this.deps.messageEmitter.emitPartialMessage(tmplCommand, originalInput, null, chunk);
        },
      });

      // Exit 255 = SSH or lxc-attach connection issue, retry only for real SSH connections
      // In test environments, don't retry as there's no real network connection
      if (
        proc.exitCode === VeExecutionConstants.SSH_EXIT_CODE_CONNECTION_ERROR &&
        this.executionMode === ExecutionMode.PRODUCTION
      ) {
        retryCount++;
        if (retryCount < maxRetries) {
          console.error(
            `Connection failed with exit 255 (attempt ${retryCount}/${maxRetries}), retrying in ${VeExecutionConstants.RETRY_DELAY_MS / 1000}s...`,
          );
          await new Promise((resolve) => setTimeout(resolve, VeExecutionConstants.RETRY_DELAY_MS));
          continue;
        }
      }
      break;
    }

    return {
      stdout: proc!.stdout || "",
      stderr: proc!.stderr || "",
      exitCode: proc!.exitCode,
    };
  }

  /**
   * Creates a message object from execution results.
   */
  createMessageFromResult(
    input: string,
    tmplCommand: ICommand,
    stdout: string,
    stderr: string,
    exitCode: number,
  ): IVeExecuteMessage {
    const message: IVeExecuteMessage = {
      stderr: structuredClone(stderr),
      commandtext: structuredClone(input),
      result: structuredClone(stdout),
      exitCode,
      command: structuredClone(tmplCommand.name),
    };
    if (tmplCommand.execute_on) {
      message.execute_on = structuredClone(tmplCommand.execute_on);
    }
    return message;
  }

  /**
   * Handles empty output case.
   */
  handleEmptyOutput(
    msg: IVeExecuteMessage,
    tmplCommand: ICommand,
    exitCode: number,
    stderr: string,
    eventEmitter: { emit: (event: string, data: any) => void },
  ): IVeExecuteMessage | null {
    msg.command = tmplCommand.name;
    msg.result = VeExecutionConstants.RESULT_OK;
    msg.exitCode = exitCode;
    if (exitCode === 0) {
      msg.result = VeExecutionConstants.RESULT_OK;
      msg.index = getNextMessageIndex();
      msg.partial = false;
      eventEmitter.emit("message", msg);
      return msg;
    } else {
      msg.result = VeExecutionConstants.RESULT_ERROR;
      msg.index = getNextMessageIndex();
      msg.stderr = stderr;
      msg.error = new JsonError(
        `Command "${tmplCommand.name}" failed with exit code ${exitCode}: ${stderr}`,
      );
      msg.exitCode = exitCode;
      msg.command = tmplCommand.name;
      msg.partial = false;
      eventEmitter.emit("message", msg);
      return null;
    }
  }

  /**
   * Executes a command on the Proxmox host via SSH, with timeout. Parses stdout as JSON and updates outputs.
   * @param input The command to execute
   * @param tmplCommand The template command
   * @param timeoutMs Timeout in milliseconds (defaults to scriptTimeoutMs if not provided)
   * @param eventEmitter EventEmitter for emitting messages
   * @param interpreter Optional interpreter extracted from shebang (e.g., ["python3"])
   */
  async runOnVeHost(
    input: string,
    tmplCommand: ICommand,
    timeoutMs: number,
    eventEmitter: { emit: (event: string, data: any) => void },
    interpreter?: string[],
  ): Promise<IVeExecuteMessage> {
    const uniqueMarker = this.createUniqueMarker();
    const executionArgs = this.buildExecutionArgs(interpreter);

    const { stdout, stderr, exitCode } = await this.executeWithRetry(
      executionArgs,
      input,
      timeoutMs,
      tmplCommand,
      input,
      interpreter,
      uniqueMarker, // Pass marker to be added based on interpreter
    );

    const msg = this.createMessageFromResult(input, tmplCommand, stdout, stderr, exitCode);

    try {
      if (stdout.trim().length === 0) {
        const result = this.handleEmptyOutput(msg, tmplCommand, exitCode, stderr, eventEmitter);
        if (result) return result;
      } else {
        // Parse and update outputs
        this.deps.outputProcessor.parseAndUpdateOutputs(stdout, tmplCommand, uniqueMarker);
        // Check if outputsRaw was updated
        const outputsRawResult = this.deps.outputProcessor.getOutputsRawResult();
        if (outputsRawResult) {
          this.deps.setOutputsRaw(outputsRawResult);
        }
      }
    } catch (e: any) {
      msg.index = getNextMessageIndex();
      // If e is already a JsonError, preserve its details; otherwise create a new one
      if (e instanceof JsonError) {
        msg.error = e;
      } else {
        msg.error = new JsonError(e.message);
      }
      msg.exitCode = -1;
      msg.partial = false;
      eventEmitter.emit("message", msg);
      throw new Error("An error occurred during command execution.");
    }
    if (exitCode !== 0) {
      throw new Error(
        `Command "${tmplCommand.name}" failed with exit code ${exitCode}: ${stderr}`,
      );
    } else msg.index = getNextMessageIndex();
    msg.partial = false;
    eventEmitter.emit("message", msg);
    return msg;
  }
}

