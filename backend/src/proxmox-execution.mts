import { EventEmitter } from "events";
import { ICommand, IProxmoxExecuteMessage, ISsh } from "@src/types.mjs";
import path from "path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { JsonValidator } from "./jsonvalidator.mjs";
export interface IProxmoxRunResult {
  lastSuccessIndex: number;
}

let index = 0;
// Generated from outputs.schema.json
export interface IOutput {
  name: string;
  value?: string;
  default?: string;
}
export interface IRestartInfo {
  vm_id: string | number;
  lastSuccessfull: number;
  inputs: { name: string; value: string | number | boolean }[];
  outputs: { name: string; value: string | number | boolean }[];
  defaults: { name: string; value: string | number | boolean }[];
}
/**
 * ProxmoxExecution: Executes a list of ICommand objects with variable substitution and remote/container execution.
 */
export class ProxmoxExecution extends EventEmitter {
  private ssh: ISsh | null = null;
  private commands!: ICommand[];
  private inputs!: Record<string, string | number | boolean>;
  public outputs: Map<string, string | number | boolean> = new Map();
  private validator: JsonValidator;
  constructor(
    commands: ICommand[],
    inputs: { name: string; value: string | number | boolean }[],
    private defaults: Map<string, string | number | boolean> = new Map(),
  ) {
    super();
    this.commands = commands;
    this.inputs = {};
    for (const inp of inputs) {
      this.inputs[inp.name] = inp.value;
    }
    // Load SSH config on instance creation
    this.ssh = ProxmoxExecution.getSshParameters();
    // Nutze Singleton-Factory für JsonValidator
    this.validator = JsonValidator.getInstance(
      path.join(process.cwd(), "schemas"),
    );
  }

  /**
   * Reads SSH parameters from ./local/sshconfig.json. Creates the directory if needed.
   */
  static getSshParameters(): ISsh | null {
    const dir = path.join(process.cwd(), "local");
    const file = path.join(dir, "sshconfig.json");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (
          data &&
          typeof data.host === "string" &&
          typeof data.port === "number"
        ) {
          return { host: data.host, port: data.port };
        }
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) {
        // ignore parse errors, treat as not set
      }
    }
    return null;
  }

  /**
   * Writes SSH parameters torunOnLxc
   *  ./local/sshconfig.json. Creates the directory if needed.
   */
  static setSshParameters(ssh: ISsh): void {
    const dir = path.join(process.cwd(), "local");
    const file = path.join(dir, "sshconfig.json");
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(file, JSON.stringify(ssh, null, 2), "utf-8");
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
    remoteCommand?: string[],
    sshCommand: string = "ssh",
  ): IProxmoxExecuteMessage {
    if (!this.ssh) throw new Error("SSH parameters not set");
    const { host, port } = this.ssh;
    let sshArgs: string[] = [];
    if (sshCommand === "ssh")
      sshArgs = [
        "-o",
        "StrictHostKeyChecking=no",
        "-q", // Suppress SSH diagnostic output
        "-p",
        String(port),
        `${host}`
      ];
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
          throw new Error(
            `Command "${tmplCommand.name}" failed with exit code ${exitCode}: ${stderr}`,
          );
        }
      }
      try {
        const outputsJson = this.validator.serializeJsonWithSchema<
          IOutput[] | IOutput
        >(
          JSON.parse(stdout),
          "outputs.schema.json",
          "Outputs " + tmplCommand.name,
        );
        if (Array.isArray(outputsJson)) {
          for (const entry of outputsJson) {
            if (entry.value) this.outputs.set(entry.name, entry.value);
            if (entry.default) this.defaults.set(entry.name, entry.default);
          }
        } else if (typeof outputsJson === "object" && outputsJson !== null) {
          if (outputsJson.value)
            this.outputs.set(outputsJson.name, outputsJson.value);
          if (outputsJson.default)
            this.defaults.set(outputsJson.name, outputsJson.default);
        }
      } catch (e) {
        msg.index = index;
        msg.commandtext = stdout;
        throw e
      }
    } catch (e) {
      msg.index = index;
      msg.error = e as Error;
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
    sshCommand: string = "ssh",
  ): IProxmoxExecuteMessage {
    // Befehl und Argumente als Array übergeben
    let lxcCmd: string[] | undefined = ["lxc-attach", "-n", String(vm_id)];
    // for testing. Just pass to when using another sshCommand, like /bin/sh
    if (sshCommand !== "ssh") lxcCmd = undefined;
    return this.runOnProxmoxHost(
      command,
      tmplCommand,
      timeoutMs,
      lxcCmd,
      sshCommand,
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
      let execStr = "";
      try {
        if (cmd.type === "script" && cmd.execute) {
          // Read script file, replace variables, then execute
          const scriptContent = fs.readFileSync(cmd.execute, "utf-8");
          execStr = this.replaceVars(scriptContent);
        } else if (cmd.type === "command" && cmd.execute) {
          execStr = this.replaceVars(cmd.execute);
        } else {
          continue; // skip unknown command type
        }
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
          case "proxmox":
            this.runOnProxmoxHost(execStr, cmd);
            break;
          default:
            let msg = cmd.name + " is missing the execute_on property";
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

        const vm_id = this.outputs.get("vm_id");
        if (vm_id !== undefined) {
          rcRestartInfo = {
            vm_id: Number.parseInt(vm_id as string, 10),
            lastSuccessfull: i,
            inputs: Object.entries(this.inputs).map(([name, value]) => ({
              name,
              value,
            })),
            outputs: Array.from(this.outputs.entries()).map(
              ([name, value]) => ({ name, value }),
            ),
            defaults: Array.from(this.defaults.entries()).map(
              ([name, value]) => ({ name, value }),
            ),
          };
        }
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
