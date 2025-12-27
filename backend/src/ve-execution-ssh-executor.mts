import { ICommand, IVeExecuteMessage } from "./types.mjs";
import { IVEContext } from "./backend-types.mjs";
import { spawnAsync } from "./spawn-utils.mjs";
import { JsonError } from "./jsonvalidator.mjs";
import { VeExecutionConstants, getNextMessageIndex } from "./ve-execution-constants.mjs";
import { VeExecutionMessageEmitter } from "./ve-execution-message-emitter.mjs";
import { OutputProcessor } from "./output-processor.mjs";

export interface SshExecutorDependencies {
  veContext: IVEContext | null;
  sshCommand: string;
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
  constructor(private deps: SshExecutorDependencies) {}

  /**
   * Builds SSH arguments for connecting to the VE host.
   */
  buildSshArgs(remoteCommand?: string[]): string[] {
    let sshArgs: string[] = [];
    if (this.deps.sshCommand === "ssh") {
      if (!this.deps.veContext) throw new Error("SSH parameters not set");
      let host = this.deps.veContext.host;
      // Ensure root user is used when no user is specified
      if (typeof host === "string" && !host.includes("@")) {
        host = `root@${host}`;
      }
      const port = this.deps.veContext.port || 22;
      sshArgs = [
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
    }
    if (remoteCommand) {
      sshArgs = sshArgs.concat(remoteCommand);
    }
    return sshArgs;
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
   */
  async executeWithRetry(
    sshArgs: string[],
    inputWithMarker: string,
    timeoutMs: number,
    tmplCommand: ICommand,
    input: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const maxRetries = VeExecutionConstants.MAX_RETRIES;
    let proc;
    let retryCount = 0;

    while (retryCount < maxRetries) {
      proc = await spawnAsync(this.deps.sshCommand, sshArgs, {
        timeout: timeoutMs,
        input: inputWithMarker,
        onStdout: (chunk: string) => {
          // Emit partial message for real-time output (especially useful for hanging scripts)
          this.deps.messageEmitter.emitPartialMessage(tmplCommand, input, chunk, "");
        },
        onStderr: (chunk: string) => {
          // Emit partial message for real-time error output
          this.deps.messageEmitter.emitPartialMessage(tmplCommand, input, null, chunk);
        },
      });

      // Exit 255 = SSH or lxc-attach connection issue, retry only for real SSH connections
      // In test environments (sshCommand !== "ssh"), don't retry as there's no real network connection
      if (
        proc.exitCode === VeExecutionConstants.SSH_EXIT_CODE_CONNECTION_ERROR &&
        this.deps.sshCommand === "ssh"
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
    return {
      stderr: structuredClone(stderr),
      commandtext: structuredClone(input),
      result: structuredClone(stdout),
      exitCode,
      command: structuredClone(tmplCommand.name),
      execute_on: structuredClone(tmplCommand.execute_on!),
    };
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
   * @param remoteCommand Optional remote command to prepend
   * @param eventEmitter EventEmitter for emitting messages
   */
  async runOnVeHost(
    input: string,
    tmplCommand: ICommand,
    timeoutMs: number,
    remoteCommand: string[] | undefined,
    eventEmitter: { emit: (event: string, data: any) => void },
  ): Promise<IVeExecuteMessage> {
    const sshArgs = this.buildSshArgs(remoteCommand);
    const uniqueMarker = this.createUniqueMarker();
    const inputWithMarker = `echo "${uniqueMarker}"\n${input}`;

    const { stdout, stderr, exitCode } = await this.executeWithRetry(
      sshArgs,
      inputWithMarker,
      timeoutMs,
      tmplCommand,
      input,
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
      msg.error = new JsonError(e.message);
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

