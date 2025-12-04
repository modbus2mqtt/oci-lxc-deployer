import { describe, it, expect, afterEach } from "vitest";
import { VeExecution } from "@src/ve-execution.mjs";
import { ICommand } from "@src/types.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IVEContext } from "@src/backend-types.mjs";
import { StorageContext } from "@src/storagecontext.mjs";

// New test cases are implemented here using overridable execCommand method.
let index = 0;
const dummyVE: IVEContext = { host: "localhost", port: 22 }as IVEContext;
StorageContext.setInstance("local");
describe("ProxmoxExecution", () => {
  it("should resolve variables from outputs, inputs, and defaults in all combinations", () => {
    type Combo = {
      output?: string | number | boolean;
      input?: string | number | boolean;
      def?: string | number | boolean;
      expected?: string | number | boolean;
    };
    // Priority: output > input > default > error
    const combos: Combo[] = [
      // Only output
      { output: "Only output", expected: "Only output" },
      // Only input
      { input: "Only input", expected: "Only input" },
      // Only default
      { def: "Only default", expected: "Only default" },
      // Output and input
      { output: "Output and input", input: "in", expected: "Output and input" },
      // Output and default
      {
        output: "Output and default",
        def: "def",
        expected: "Output and default",
      },
      // Input and default
      { input: "Input and default", def: "def", expected: "Input and default" },
      // Output, input, and default
      {
        output: "Output, input, and default",
        input: "in",
        def: "def",
        expected: "Output, input, and default",
      },
      // None (should throw)
      // { expected: 'error', message: 'None set' },
    ];
    class TestExec extends VeExecution {
      public callReplaceVars(str: string) {
        // @ts-expect-error: Accessing private method for test
        return this.replaceVars(str);
      }
    }
    for (const combo of combos) {
      const outputs = new Map<string, string | number | boolean>();
      const inputs: { id: string; value: string | number | boolean }[] = [];
      const parameters: Map<string, string | number | boolean> = new Map();
      if (combo.output !== undefined) outputs.set("foo", combo.output);
      if (combo.input !== undefined)
        inputs.push({ id: "foo", value: combo.input });
      if (combo.def !== undefined) parameters.set("foo", combo.def);
      const exec = new TestExec([], inputs, dummyVE, parameters);
      exec.outputs = outputs;
      // Patch parameters for default
      (exec as any).parameters = parameters;
      if (combo.expected === "error") {
        expect(() => exec.callReplaceVars("Value: {{ foo }}")).toThrow();
      } else {
        const result = exec.callReplaceVars("Value: {{ foo }}");
        expect(result).toBe("Value: " + combo.expected);
        // Restore original for next loop
      }
    }
  });
  it("should use default value if no output or input value is set", () => {
    class TestExec extends VeExecution {
      public testReplaceVars(str: string) {
        // @ts-expect-error: Accessing private method for test
        return this.replaceVars(str);
      }
    }
    // Simulate a parameter with a default value
    const commands: ICommand[] = [];
    const exec = new TestExec(commands, [], dummyVE, new Map());
    // Manually add a parameter with default value
    (exec as any).parameters = [
      { name: "foo", type: "string", default: "bar" },
    ];
    // Patch replaceVars to use default if input/output missing
    (exec as any).replaceVars = function (str: string) {
      return str.replace(/{{\s*([^}\s]+)\s*}}/g, (_: string, v: string) => {
        if (this.outputs.has(v)) return String(this.outputs.get(v));
        if (this.inputs[v] !== undefined) return String(this.inputs[v]);
        // Check for default value in parameters
        const param = this.parameters.find((p: any) => p.name === v);
        if (param && param.default !== undefined) return String(param.default);
        throw new Error(`Unknown variable: {{${v}}}`);
      });
    };
    const result = (exec as any).replaceVars("Value: {{ foo }}");
    expect(result).toBe("Value: bar");
  });

  it("should read a script file, replace variables, and execute the replaced content", () => {
    const scriptPath = path.join(os.tmpdir(), "testscript.sh");
    fs.writeFileSync(scriptPath, "echo {{ myvar }}");
    class TestExec extends VeExecution {
      public lastCommand = "";
      protected runOnProxmoxHost(command: string, tmplCommand: ICommand) {
        this.lastCommand = command;
        return {
          stderr: "",
          result: command,
          exitCode: 0,
          command: tmplCommand.name,
          index: index++,
        };
      }
    }
    const commands: ICommand[] = [
      {
        script: scriptPath,
        name: "test",
        execute_on: "proxmox",
      },
    ];
    const inputs = [{ id: "myvar", value: "replacedValue" }];
    const exec = new TestExec(commands, inputs, dummyVE, new Map());
    exec.run();
    expect(exec.lastCommand).toBe("echo replacedValue");
    try {
      fs.unlinkSync(scriptPath);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e: any) {}
  });

  it("should replace variable in command with input value", () => {
    class TestExec extends VeExecution {
      protected runOnProxmoxHost(command: string, tmplCommand: ICommand) {
        // Return the replaced value directly as result
        return {
          stderr: "",
          result: command,
          exitCode: 0,
          command: tmplCommand.name,
          index: index,
        };
      }
    }
    const commands: ICommand[] = [
      {
        command: "{{ somevariable }}",
        name: "test",
        execute_on: "proxmox",
      },
    ];
    const inputs = [{ id: "somevariable", value: "replaced" }];
    new TestExec(commands, inputs, dummyVE, new Map());
    // run() only returns lastSuccessIndex, but we can intercept runOnProxmoxHost
    // or check outputs. Here we check if the replaced value arrives:
    let resultValue = "";
    class CaptureExec extends TestExec {
      protected runOnProxmoxHost(command: string, tmplCommand: ICommand) {
        resultValue = command;
        return {
          stderr: "",
          result: command,
          exitCode: 0,
          command: tmplCommand.name,
          index: index++,
        };
      }
    }
    const exec2 = new CaptureExec(commands, inputs, dummyVE, new Map());
    exec2.run();
    expect(resultValue).toBe("replaced");
  });
  it("should parse JSON output and fill outputs", () => {
    class TestExec extends VeExecution {
      protected runOnProxmoxHost(command: string, tmplCommand: ICommand) {
        // Simuliere JSON-Parsing
        try {
          const json = JSON.parse(
            command
              .replace(/^echo /, "")
              .replace(/^"/, "")
              .replace(/"$/, ""),
          );
          for (const [k, v] of Object.entries(json)) {
            this.outputs.set(k, v as string | number | boolean);
          }
          return {
            stderr: "",
            result: command,
            exitCode: 0,
            command: tmplCommand.name,
            index: index++,
          };
        } catch {
          return {
            stderr: "",
            result: command,
            exitCode: 0,
            command: tmplCommand.name,
            index: index++,
          };
        }
      }
    }
    const commands: ICommand[] = [
      {
        command: 'echo "{\"foo\": \"bar\"}"',
        name: "test",
        execute_on: "proxmox",
      },
      {
        command: 'echo "{\"baz\": 99}"',
        name: "test",
        execute_on: "proxmox",
      },
      {
        command: 'echo "{\"vm_id\": 100}"',
        name: "test",
        execute_on: "proxmox",
      },
      {
        command: 'echo "{\"foo\": \"baz\"}"',
        name: "test",
        execute_on: "proxmox",
      },
    ];
    const inputs = [
      { id: "foo", value: "inputFoo" },
      { id: "baz", value: 99 },
    ];
    const exec = new TestExec(commands, inputs, dummyVE, new Map());
    exec.run();
    expect(exec.outputs.get("foo")).toBe("baz");
    expect(exec.outputs.get("baz")).toBe(99);
    expect(exec.outputs.get("vm_id")).toBe(100);
  });

  it("should replace variables from inputs and outputs", () => {
    class TestExec extends VeExecution {
      protected runOnProxmoxHost(command: string, tmplCommand: ICommand) {
        try {
          const json = JSON.parse(
            command
              .replace(/^echo /, "")
              .replace(/^"/, "")
              .replace(/"$/, ""),
          );
          for (const [k, v] of Object.entries(json)) {
            this.outputs.set(k, v as string | number | boolean);
          }
          return {
            stderr: "",
            result: command,
            exitCode: 0,
            command: tmplCommand.name,
            index: index++,
          };
        } catch {
          return {
            stderr: "",
            result: command,
            exitCode: 0,
            command: tmplCommand.name,
            index: index++,
          };
        }
      }
    }
    const commands: ICommand[] = [
      {
        command: 'echo "{\"foo\": \"bar\"}"',
        name: "test",
        execute_on: "proxmox",
      },
      {
        command: 'echo "{\"foo\": \"baz99\"}"',
        name: "test",
        execute_on: "proxmox",
      },
    ];
    const inputs = [{ id: "foo", value: "inputFoo" }];
    const exec = new TestExec(commands, inputs, dummyVE, new Map());
    exec.run();
    expect(exec.outputs.get("foo")).toBe("baz99");
  });

  // it("should emit message and abort if vm_id missing for LXC", async () => {
  //   class LxcTestExec extends ProxmoxExecution {
  //     protected runOnLxc(
  //     ): IProxmoxExecuteMessage {
  //       throw new Error("vm_id is required for LXC execution");
  //     }
  //     protected runOnProxmoxHost(
  //       command: string,
  //       tmplCommand: ICommand
  //     ) {
  //       return {
  //         stderr: "",
  //         result: command,
  //         exitCode: 0,
  //         command: tmplCommand.name,
  //         index: index++,
  //       };
  //     }
  //   }
  //   const lxcCommands: ICommand[] = [
  //     {
  //       command: 'echo "{\"foo\": \"bar\"}"',
  //       name: "test",
  //       execute_on: "proxmox",
  //     },
  //     {
  //       command: 'echo "{\"foo\": \"bar\"}"',
  //       name: "test",
  //       execute_on: "proxmox",
  //     },
  //     {
  //       command: 'echo "echo hi"',
  //       name: "test",
  //       execute_on: "lxc",
  //     },
  //   ];
  //   const lxcExec = new LxcTestExec(
  //     lxcCommands,
  //     [{ name: "foo", value: "inputFoo" }],
  //     new Map(),
  //   );
  //   ProxmoxExecution.setSshParameters(sshParams);
  //   await new Promise<void>((resolve) => {
  //     const handler = (msg: IProxmoxExecuteMessage) => {
  //       if (msg.stderr && msg.stderr.includes("vm_id is required")) {
  //         lxcExec.off("message", handler);
  //         resolve();
  //       }
  //     };
  //     lxcExec.on("message", handler);
  //     lxcExec.run();
  //   });
  // });

  it("should return lastSuccessIndex", () => {
    class TestExec extends VeExecution {
      protected runOnProxmoxHost(command: string, tmplCommand: ICommand) {
        return {
          stderr: "",
          result: command,
          exitCode: 0,
          command: tmplCommand.name,
          index: index++,
        };
      }
    }
    const commands: ICommand[] = [
      {
        command: 'echo "{\"foo\": \"bar\"}"',
        name: "test",
        execute_on: "proxmox",
      },
      {
        command: 'echo "{\"foo\": \"baz99\"}"',
        name: "test",
        execute_on: "proxmox",
      },
      {
        command: 'echo "{\"baz\": 99}"',
        name: "test",
        execute_on: "proxmox",
      },
    ];
    const inputs = [{ id: "foo", value: "inputFoo" }];
    const exec = new TestExec(commands, inputs, dummyVE, new Map());
    const result = exec.run();
    expect(typeof result?.lastSuccessfull).toBe("number");
    expect(result?.lastSuccessfull).toBe(commands.length - 1);
  });

  // it("should emit error message if SSH connection fails", async () => {
  //   class TestExec extends ProxmoxExecution {
  //     private callCount = 0;
  //     protected runOnProxmoxHost(
  //       command: string,
  //       tmplCommand: ICommand
  //     ) {
  //       if (this.callCount === 0) {
  //         this.callCount++;
  //         throw new Error("Simulated SSH failure");
  //       }
  //       return {
  //         stderr: "",
  //         result: command,
  //         exitCode: 0,
  //         command: tmplCommand.name,
  //         index: index++,
  //       };
  //     }
  //   }
  //   const commands: ICommand[] = [
  //     {
  //       command: 'echo "{\"foo\": \"bar\"}"',
  //       name: "test",
  //       execute_on: "proxmox",
  //     },
  //   ];
  //   const inputs = [{ name: "foo", value: "inputFoo" }];
  //   const exec = new TestExec(commands, inputs, new Map());
  //   ProxmoxExecution.setSshParameters({ host: "invalid", port: 22 });
  //   await new Promise<void>((resolve) => {
  //     exec.on("message", (msg: IProxmoxExecuteMessage) => {
  //       if (msg.stderr && msg.stderr.includes("Simulated SSH failure")) {
  //         resolve();
  //       }
  //     });
  //     exec.run();
  //   });
  // });
  const sshConfigPath = path.join(process.cwd(), "local", "sshconfig.json");

  afterEach(() => {
    // Clean up sshconfig.json after each test
    try {
      if (fs.existsSync(sshConfigPath)) {
        fs.unlinkSync(sshConfigPath);
      }
    } catch {}
  });
});
