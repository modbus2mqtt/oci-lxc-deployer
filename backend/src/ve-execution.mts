import { EventEmitter } from "events";
import { ICommand, IVeExecuteMessage } from "@src/types.mjs";
import fs from "node:fs";
import path from "node:path";
import { spawn, SpawnOptionsWithoutStdio } from "node:child_process";

function spawnAsync(
  cmd: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { input?: string; timeout?: number }
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { ...options, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let timeoutId: NodeJS.Timeout | undefined;

    if (options.input) {
      proc.stdin?.write(options.input);
      proc.stdin?.end();
    }

    proc.stdout?.on("data", (d) => (stdout += d.toString()));
    proc.stderr?.on("data", (d) => (stderr += d.toString()));

    if (options.timeout) {
      timeoutId = setTimeout(() => {
        proc.kill("SIGTERM");
      }, options.timeout);
    }

    proc.on("close", (exitCode) => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout, stderr, exitCode: exitCode ?? -1 });
    });

    proc.on("error", () => {
      if (timeoutId) clearTimeout(timeoutId);
      resolve({ stdout, stderr, exitCode: -1 });
    });
  });
}
import { JsonError, JsonValidator } from "./jsonvalidator.mjs";
import { StorageContext, VMContext } from "./storagecontext.mjs";
import { IVEContext, IVMContext } from "./backend-types.mjs";
export interface IProxmoxRunResult {
  lastSuccessIndex: number;
}

let index = 0;
// Generated from outputs.schema.json
export interface IOutput {
  id: string;
  value?: string;
  default?: string;
}
export interface IRestartInfo {
  vm_id?: string | number | undefined;
  lastSuccessfull: number;
  inputs: { name: string; value: string | number | boolean }[];
  outputs: { name: string; value: string | number | boolean }[];
  defaults: { name: string; value: string | number | boolean }[];
}
/**
 * ProxmoxExecution: Executes a list of ICommand objects with variable substitution and remote/container execution.
 */
export class VeExecution extends EventEmitter {
  private commands!: ICommand[];
  private inputs!: Record<string, string | number | boolean>;
  public outputs: Map<string, string | number | boolean> = new Map();
  private outputsRaw?: { name: string; value: string | number | boolean }[];
  private validator: JsonValidator;
  constructor(
    commands: ICommand[],
    inputs: { id: string; value: string | number | boolean }[],
    private veContext: IVEContext | null,
    private defaults: Map<string, string | number | boolean> = new Map(),
    protected sshCommand: string = "ssh",
  ) {
    super();
    this.commands = commands;
    this.inputs = {};
    for (const inp of inputs) {
      this.inputs[inp.id] = inp.value;
    }
    this.validator = StorageContext.getInstance().getJsonValidator();
  }

  /**
   * Executes a command on the Proxmox host via SSH, with timeout. Parses stdout as JSON and updates outputs.
   * @param command The command to execute
   * @param timeoutMs Timeout in milliseconds
   */
  protected async runOnVeHost(
    input: string,
    tmplCommand: ICommand,
    timeoutMs = 300000, // 5 minutes default for long-running commands like npm install
    remoteCommand?: string[],
  ): Promise<IVeExecuteMessage> {
    const sshCommand = this.sshCommand;
    let sshArgs: string[] = [];
    if (sshCommand === "ssh") {
      if (!this.veContext) throw new Error("SSH parameters not set");
      let host = this.veContext.host;
      // Ensure root user is used when no user is specified
      if (typeof host === "string" && !host.includes("@")) {
        host = `root@${host}`;
      }
      const port = this.veContext.port || 22;
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
    // Retry logic for SSH/lxc-attach connection errors (exit 255)
    const maxRetries = 3;
    let proc;
    let retryCount = 0;
    
    while (retryCount < maxRetries) {
      proc = await spawnAsync(sshCommand, sshArgs, {
        timeout: timeoutMs,
        input,
      });
      
      // Exit 255 = SSH or lxc-attach connection issue, always retry
      if (proc.exitCode === 255) {
        retryCount++;
        if (retryCount < maxRetries) {
          console.error(`Connection failed with exit 255 (attempt ${retryCount}/${maxRetries}), retrying in 3s...`);
          await new Promise(resolve => setTimeout(resolve, 3000)); // wait 3s before retry
          continue;
        }
      }
      break;
    }
    
    const stdout = proc!.stdout || "";
    const stderr = proc!.stderr || "";
    const exitCode = proc!.exitCode;
    // Try to parse stdout as JSON and update outputs
    const msg: IVeExecuteMessage = {
      stderr: structuredClone(stderr),
      commandtext: structuredClone(input),
      result: structuredClone(stdout),
      exitCode,
      command: structuredClone(tmplCommand.name),
      execute_on: structuredClone(tmplCommand.execute_on!),
    };
    try {
      if (stdout.trim().length === 0) {
        // output is empty but exit code 0
        // no outputs to parse
        msg.command = tmplCommand.name;
        msg.result = "OK";
        msg.exitCode = exitCode;
        if (exitCode === 0) {
          msg.result = "OK";
          msg.index = index++;
          this.emit("message", msg);
          return msg;
        } else {
          msg.result = "ERROR";
          msg.index = index;
          msg.stderr = stderr;
          msg.error = new JsonError(
            `Command "${tmplCommand.name}" failed with exit code ${exitCode}: ${stderr}`,
          );
          msg.exitCode = exitCode;
          msg.command = tmplCommand.name;
          msg.commandtext = input;
          this.emit("message", msg);
        }
      }

      try {
        // Some systems print login banners before command output. Strip leading banner text.
        let cleaned = stdout.trim();
        const firstJsonIdx = Math.min(
          ...["{", "["].map((c) => {
            const i = cleaned.indexOf(c);
            return i === -1 ? Number.POSITIVE_INFINITY : i;
          }),
        );
        if (Number.isFinite(firstJsonIdx) && firstJsonIdx > 0) {
          cleaned = cleaned.slice(firstJsonIdx);
        }
        if(cleaned.length != 0) {
          const parsed = JSON.parse(cleaned);
          // Validate against schema; may be one of:
          // - IOutput
          // - IOutput[]
          // - Array<{name, value}>
          const outputsJson = this.validator.serializeJsonWithSchema<any>(
            parsed,
            "outputs",
            "Outputs " + tmplCommand.name,
          );
  
          if (Array.isArray(outputsJson)) {
            const first = outputsJson[0];
            if (
              first &&
              typeof first === "object" &&
              "name" in first &&
              !("id" in first)
            ) {
              // name/value array: pass through 1:1 to outputsRaw and also map for substitutions
              this.outputsRaw = [];
              for (const nv of outputsJson as { name: string; value: string | number | boolean }[]) {
                const processedValue = this.processLocalFileValue(nv.value);
                this.outputsRaw.push({ name: nv.name, value: processedValue });
                this.outputs.set(nv.name, processedValue);
              }
            } else {
              // Array of outputObject {id, value}
              for (const entry of outputsJson as IOutput[]) {
                if (entry.value !== undefined) {
                  const processedValue = this.processLocalFileValue(entry.value);
                  this.outputs.set(entry.id, processedValue);
                }
                if ((entry as any).default !== undefined)
                  this.defaults.set(entry.id, (entry as any).default as any);
              }
            }
          } else if (typeof outputsJson === "object" && outputsJson !== null) {
            const obj = outputsJson as IOutput;
            if (obj.value !== undefined) {
              const processedValue = this.processLocalFileValue(obj.value);
              this.outputs.set(obj.id, processedValue);
            }
            if ((obj as any).default !== undefined)
              this.defaults.set(obj.id, (obj as any).default as any);
          }
        }

      } catch (e) {
        msg.index = index;
        msg.commandtext = stdout;
        msg.stderr = stderr;
        throw e;
      }
    } catch (e:any)  {
      msg.index = index;
      msg.error = new JsonError( e.message);
      msg.exitCode = -1;
      this.emit("message", msg);
      throw new Error("An error occurred during command execution.");
    }
    if (exitCode !== 0) {
      throw new Error(
        `Command "${tmplCommand.name}" failed with exit code ${exitCode}: ${stderr}`,
      );
    } else msg.index = index++;
    this.emit("message", msg);
    return msg;
  }

  /**
   * Executes a command inside an LXC container via lxc-attach on the Proxmox host.
   * @param vm_id Container ID
   * @param command Command to execute
   * @param timeoutMs Timeout in ms
   */
  protected async runOnLxc(
    vm_id: string | number,
    command: string,
    tmplCommand: ICommand,
    timeoutMs = 300000, // 5 minutes default
  ): Promise<IVeExecuteMessage> {
    // Pass command and arguments as array
    let lxcCmd: string[] | undefined = ["lxc-attach", "-n", String(vm_id)];
    // For testing: just pass through when using another sshCommand, like /bin/sh
    if (this.sshCommand !== "ssh") lxcCmd = undefined;
    return await this.runOnVeHost(command, tmplCommand, timeoutMs, lxcCmd);
  }

  /**
   * Executes host discovery flow: calls write-vmids-json.sh on VE host, parses used_vm_ids,
   * resolves VMContext by hostname, validates pve and vmid, then runs the provided command inside LXC.
   */
  protected async executeOnHost(
    hostname: string,
    command: string,
    tmplCommand: ICommand,
  ): Promise<void> {
    const { join, dirname } = require("node:path");
    const { fileURLToPath } = require("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const scriptPath = join(
      here,
      "..",
      "json",
      "shared",
      "scripts",
      "write-vmids-json.sh",
    );
    const probeMsg = await this.runOnVeHost(
      "",
      { ...tmplCommand, name: "write-vmids" } as any,
      10000,
      [scriptPath],
    );
    // Prefer parsed outputsRaw (name/value) if available
    let usedStr: string | undefined = undefined;
    if (this.outputs.has("used_vm_ids"))
      usedStr = String(this.outputs.get("used_vm_ids"));
    if (!usedStr && typeof probeMsg.result === "string")
      usedStr = probeMsg.result as string;
    if (!usedStr)
      throw new Error("No used_vm_ids result received from host probe");
    let arr: any;
    try {
      arr = JSON.parse(usedStr);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e) {
      throw new Error("Invalid used_vm_ids JSON");
    }
    if (!Array.isArray(arr)) throw new Error("used_vm_ids is not an array");
    const found = arr.find(
      (x: any) => typeof x?.hostname === "string" && x.hostname === hostname,
    );
    if (!found)
      throw new Error(`Hostname ${hostname} not found in used_vm_ids`);
    const storage = StorageContext.getInstance();
    const vmctx = storage.getVMContextByHostname(hostname);
    if (!vmctx) throw new Error(`VMContext for ${hostname} not found`);
    const pveOk =
      (vmctx as any)?.data?.pve !== undefined &&
      (vmctx as any).data.pve === found.pve;
    const vmidOk = Number(vmctx.vmid) === Number(found.vmid);
    if (!pveOk || !vmidOk)
      throw new Error("PVE or VMID mismatch between host data and VMContext");
    // Replace variables with vmctx.data for host execution
    var execCmd = this.replaceVarsWithContext(
      command,
      (vmctx as any).data || {},
    );
    execCmd = this.replaceVarsWithContext(execCmd, this.outputs || {});
    await this.runOnLxc(vmctx.vmid, execCmd, tmplCommand);
  }

  /**
   * Runs all commands, replacing variables from inputs/outputs, and executes them on the correct target.
   * Returns the index of the last successfully executed command.
   */
  async run(restartInfo: IRestartInfo | null = null): Promise<IRestartInfo | undefined> {
    let rcRestartInfo: IRestartInfo | undefined = undefined;
    let msgIndex = 0;
    let startIdx = 0;
    if (restartInfo) {
      // Load previous state
      this.outputs.clear();
      this.inputs = {};
      this.defaults.clear();
      restartInfo.lastSuccessfull !== undefined &&
        (startIdx = restartInfo.lastSuccessfull + 1);
      for (const inp of restartInfo.inputs) {
        this.inputs[inp.name] = inp.value;
      }
      for (const outp of restartInfo.outputs) {
        this.outputs.set(outp.name, outp.value);
      }
      for (const def of restartInfo.defaults) {
        this.defaults.set(def.name, def.value);
      }
    }
    outerloop: for (let i = startIdx; i < this.commands.length; ++i) {
      const cmd = this.commands[i];
      if (!cmd || typeof cmd !== "object") continue;
      // Reset raw outputs for this command iteration
      let rawStr = "";
      try {
        if (cmd.script !== undefined) {
          // Read script file, replace variables, then execute
          rawStr = fs.readFileSync(cmd.script, "utf-8");
        } else if (cmd.command !== undefined) {
          rawStr = cmd.command;
        } else {
          continue; // Skip unknown command type
        }
        let lastMsg: IVeExecuteMessage | undefined;
        switch (cmd.execute_on) {
          case "lxc":
            // For lxc path, perform default variable replacement
            const execStrLxc = this.replaceVars(rawStr);
            let vm_id: string | number | undefined = undefined;
            if (
              typeof this.inputs["vm_id"] === "string" ||
              typeof this.inputs["vm_id"] === "number"
            ) {
              vm_id = this.inputs["vm_id"];
            } else if (this.outputs.has("vm_id")) {
              const v = this.outputs.get("vm_id");
              if (typeof v === "string" || typeof v === "number") {
                vm_id = v;
              }
            }
            if (!vm_id) {
              const msg =
                "vm_id is required for LXC execution but was not found in inputs or outputs.";
              this.emit("message", {
                stderr: msg,
                result: null,
                exitCode: -1,
                command: cmd.name,
                execute_on: cmd.execute_on,
                index: msgIndex++,
              } as IVeExecuteMessage);
              break outerloop;
            }
            await this.runOnLxc(vm_id, execStrLxc, cmd);
            break;
          case "ve":
            // Default replacement for direct ve execution
            const execStrVe = this.replaceVars(rawStr);
            lastMsg = await this.runOnVeHost(execStrVe, cmd);
            break;
          default:
            if (
              typeof cmd.execute_on === "string" &&
              /^host:.*/.test(cmd.execute_on)
            ) {
              const hostname = (cmd.execute_on as string).split(":")[1] ?? "";
              try {
                // Pass raw (unreplaced) string; executeOnHost will replace with vmctx.data
                await this.executeOnHost(hostname, rawStr, cmd);
              } catch (err: any) {
                const msg = String(err?.message ?? err);
                this.emit("message", {
                  stderr: msg,
                  result: null,
                  exitCode: -1,
                  command: cmd.name,
                  execute_on: cmd.execute_on,
                  host: hostname,
                  index: msgIndex++,
                } as unknown as IVeExecuteMessage);
                break outerloop;
              }
              break;
            } else {
              const msg = cmd.name + " is missing the execute_on property";
              this.emit("message", {
                stderr: msg,
                result: null,
                exitCode: -1,
                command: cmd.name,
                execute_on: cmd.execute_on!,
                index: msgIndex++,
              } as IVeExecuteMessage);
              break outerloop;
            }
        }

        // Fallback: if no outputs were produced by runOnProxmoxHost override, try to parse echo JSON
        if (
          this.outputs.size === 0 &&
          lastMsg &&
          typeof lastMsg.result === "string"
        ) {
          const m = String(lastMsg.result)
            .replace(/^echo\s+/, "")
            .replace(/^"/, "")
            .replace(/"$/, "");
          try {
            const obj = JSON.parse(m);
            this.outputsRaw = [];
            for (const [name, value] of Object.entries(obj)) {
              const v = value as string | number | boolean;
              this.outputs.set(name, v);
              this.outputsRaw.push({ name, value: v });
            }
          } catch {}
        }

        const vm_id = this.outputs.get("vm_id");
        rcRestartInfo = {
          vm_id:
            vm_id !== undefined
              ? Number.parseInt(vm_id as string, 10)
              : undefined,
          lastSuccessfull: i,
          inputs: Object.entries(this.inputs).map(([name, value]) => ({
            name,
            value,
          })),
          outputs:
            this.outputsRaw && Array.isArray(this.outputsRaw)
              ? this.outputsRaw.map(({ name, value }) => ({ name, value }))
              : Array.from(this.outputs.entries()).map(([name, value]) => ({
                  name,
                  value,
                })),
          defaults: Array.from(this.defaults.entries()).map(
            ([name, value]) => ({ name, value }),
          ),
        };
      } catch (e) {
        this.emit("message", {
          stderr: (e as any).message,
          result: null,
          exitCode: -1,
          command: cmd.name,
          execute_on: cmd.execute_on,
          index: msgIndex++,
        } as IVeExecuteMessage);
        // Set restartInfo even on error so restart is possible
        const vm_id = this.outputs.get("vm_id");
        rcRestartInfo = {
          vm_id: vm_id !== undefined ? Number.parseInt(vm_id as string, 10) : undefined,
          lastSuccessfull: i - 1,
          inputs: Object.entries(this.inputs).map(([name, value]) => ({ name, value })),
          outputs: this.outputsRaw && Array.isArray(this.outputsRaw)
            ? this.outputsRaw.map(({ name, value }) => ({ name, value }))
            : Array.from(this.outputs.entries()).map(([name, value]) => ({ name, value })),
          defaults: Array.from(this.defaults.entries()).map(([name, value]) => ({ name, value })),
        };
        break outerloop;
      }
    }
    // Check if all commands completed successfully
    const allSuccessful = rcRestartInfo !== undefined && 
      rcRestartInfo.lastSuccessfull === this.commands.length - 1;
    
    if (allSuccessful) {
      // Send a final success message
      this.emit("message", {
        command: "Completed",
        execute_on: "ve",
        exitCode: 0,
        result: "All commands completed successfully",
        stderr: "",
        finished: true,
      } as IVeExecuteMessage);
      
      if (restartInfo == undefined) {
        this.emit("finished", this.buildVmContext());
      }
    }
    return rcRestartInfo;
  }
  buildVmContext(): IVMContext {
    if (!this.veContext) {
      throw new Error("VE context not set");
    }
    var data: any = {};
    data.vmid = this.outputs.get("vm_id");
    const hostVal = (this.veContext as any)?.host;
    const veKey =
      typeof (this.veContext as any)?.getKey === "function"
        ? (this.veContext as any).getKey()
        : typeof hostVal === "string"
          ? `ve_${hostVal}`
          : undefined;
    data.vekey = veKey;
    data.data = {};

    this.outputs.forEach((value, key) => {
      data.data[key] = value;
    });
    return new VMContext(data);
  }

  /**
   * Processes a value: if it's a string starting with "local:", reads the file and returns base64 encoded content.
   */
  private processLocalFileValue(value: string | number | boolean): string | number | boolean {
    if (typeof value === 'string' && value.startsWith('local:')) {
      const filePath = value.substring(6); // Remove "local:" prefix
      const storageContext = StorageContext.getInstance();
      const localPath = storageContext.getLocalPath();
      const fullPath = path.join(localPath, filePath);
      try {
        const fileContent = fs.readFileSync(fullPath);
        return fileContent.toString('base64');
      } catch (err: any) {
        throw new Error(`Failed to read file ${fullPath}: ${err.message}`);
      }
    }
    return value;
  }

  /**
   * Replaces {{var}} in a string with values from inputs or outputs.
   */
  private replaceVars(str: string): string {
    return this.replaceVarsWithContext(str, {});
  }

  /**
   * Replace variables using a provided context map first (e.g., vmctx.data),
   * then fall back to outputs, inputs, and defaults.
   */
  protected replaceVarsWithContext(
    str: string,
    ctx: Record<string, any>,
  ): string {
    return str.replace(/{{\s*([^}\s]+)\s*}}/g, (_: string, v: string) => {
      if (ctx && Object.prototype.hasOwnProperty.call(ctx, v)) {
        const val = ctx[v];
        if (val !== undefined && val !== null) return String(val);
      }
      if (this.outputs.has(v)) return String(this.outputs.get(v));
      if (this.inputs[v] !== undefined) return String(this.inputs[v]);
      if (this.defaults.has(v)) return String(this.defaults.get(v));
      throw new Error(`Unknown variable: {{${v}}}`);
    });
  }
}
