import { EventEmitter } from "events";
import { ICommand, IJsonError, IProxmoxExecuteMessage } from "@src/types.mjs";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { JsonError, JsonValidator } from "./jsonvalidator.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { IVEContext } from "./backend-types.mjs";
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
    protected sshCommand: string = "ssh"
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
  protected runOnProxmoxHost(
    input: string,
    tmplCommand: ICommand,
    timeoutMs = 10000,
    remoteCommand?: string[]
  ): IProxmoxExecuteMessage {
    const sshCommand = this.sshCommand;
    let sshArgs: string[] = [];
    if (sshCommand === "ssh") {
      if (!this.veContext) throw new Error("SSH parameters not set");
      const host = this.veContext.host;
      const port = this.veContext.port || 22;
      sshArgs = [
        "-o",
        "StrictHostKeyChecking=no",
        "-q", // Suppress SSH diagnostic output
        "-p",
        String(port),
        `${host}`,
      ];
    }
    if (remoteCommand) {
      sshArgs = sshArgs.concat(remoteCommand);
    }
    const proc = spawnSync(sshCommand, sshArgs, {
      encoding: "utf-8",
      timeout: timeoutMs,
      input,
      stdio: "pipe",
    });
    const stdout = proc.stdout || "";
    const stderr = proc.stderr || "";
    // Only 'status' is available on SpawnSyncReturns<string> in Node.js typings
    const exitCode = typeof proc.status === "number" ? proc.status : -1;
    // Try to parse stdout as JSON and update outputs
    const msg: IProxmoxExecuteMessage = {
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
          this.emit("message", msg);
          throw new JsonError(
            `Command "${tmplCommand.name}" failed with exit code ${exitCode}: ${stderr}`,
          );
        }
      }

      try {
        const parsed = JSON.parse(stdout);
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
          if (first && typeof first === "object" && "name" in first && !("id" in first)) {
            // name/value array: pass through 1:1 to outputsRaw and also map for substitutions
            this.outputsRaw = outputsJson as { name: string; value: string | number | boolean }[];
            for (const nv of this.outputsRaw) {
              this.outputs.set(nv.name, nv.value);
            }
          } else {
            // Array of outputObject {id, value}
            for (const entry of outputsJson as IOutput[]) {
              if (entry.value !== undefined) this.outputs.set(entry.id, entry.value);
              if ((entry as any).default !== undefined)
                this.defaults.set(entry.id, (entry as any).default as any);
            }
          }
        } else if (typeof outputsJson === "object" && outputsJson !== null) {
          const obj = outputsJson as IOutput;
          if (obj.value !== undefined) this.outputs.set(obj.id, obj.value);
          if ((obj as any).default !== undefined)
            this.defaults.set(obj.id, (obj as any).default as any);
        }
      } catch (e) {
        msg.index = index;
        msg.commandtext = stdout;
        throw e;
      }
    } catch (e) {
      msg.index = index;
      msg.error = e as IJsonError;
      msg.exitCode = -1;
      this.emit("message", msg);
      throw e;
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
  protected runOnLxc(
    vm_id: string | number,
    command: string,
    tmplCommand: ICommand,
    timeoutMs = 10000,
  ): IProxmoxExecuteMessage {
    // Pass command and arguments as array
    let lxcCmd: string[] | undefined = ["lxc-attach", "-n", String(vm_id)];
    // For testing: just pass through when using another sshCommand, like /bin/sh
    if (this.sshCommand !== "ssh") lxcCmd = undefined;
    return this.runOnProxmoxHost(
      command,
      tmplCommand,
      timeoutMs,
      lxcCmd,
    );
  }

  /**
   * Runs all commands, replacing variables from inputs/outputs, and executes them on the correct target.
   * Returns the index of the last successfully executed command.
   */
  run(restartInfo: IRestartInfo | null = null): IRestartInfo | undefined {
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
      let execStr = "";
      try {
        if (cmd.script !== undefined) {
          // Read script file, replace variables, then execute
          const scriptContent = fs.readFileSync(cmd.script, "utf-8");
          execStr = this.replaceVars(scriptContent);
        } else if (cmd.command !== undefined) {
          execStr = this.replaceVars(cmd.command);
        } else {
          continue; // Skip unknown command type
        }
        let lastMsg: IProxmoxExecuteMessage | undefined;
        switch (cmd.execute_on) {
          case "lxc":
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
              } as IProxmoxExecuteMessage);
              break outerloop;
            }
            this.runOnLxc(vm_id, execStr, cmd);
            break;
          case "ve":
            lastMsg = this.runOnProxmoxHost(execStr, cmd);
            break;
          default:
                if (typeof cmd.execute_on === "string" && /^host:.*/.test(cmd.execute_on)) {
                  const hostname = (cmd.execute_on as string).split(":")[1] ?? "";
                  const msg = `host: is not implemented yet.`;
                  this.emit("message", {
                    stderr: msg,
                    result: null,
                    exitCode: -1,
                    command: cmd.name,
                    execute_on: cmd.execute_on,
                    host: hostname,
                    index: msgIndex++,
                  } as unknown as IProxmoxExecuteMessage);
                  break outerloop;
                } else {
                  const msg = cmd.name + " is missing the execute_on property";
                  this.emit("message", {
                    stderr: msg,
                    result: null,
                    exitCode: -1,
                    command: cmd.name,
                    execute_on: cmd.execute_on!,
                    index: msgIndex++,
                  } as IProxmoxExecuteMessage);
                  break outerloop;
                }
        }

        // Fallback: if no outputs were produced by runOnProxmoxHost override, try to parse echo JSON
        if (this.outputs.size === 0 && lastMsg && typeof lastMsg.result === "string") {
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
        } as IProxmoxExecuteMessage);
        break outerloop;
      }
    }
    return rcRestartInfo;
  }

  /**
   * Replaces {{var}} in a string with values from inputs or outputs.
   */
  private replaceVars(str: string): string {
    return str.replace(/{{\s*([^}\s]+)\s*}}/g, (_: string, v: string) => {
      if (this.outputs.has(v)) return String(this.outputs.get(v));
      if (this.inputs[v] !== undefined) return String(this.inputs[v]);
      if (this.defaults.has(v)) return String(this.defaults.get(v));
      throw new Error(`Unknown variable: {{${v}}}`);
    });
  }
}
