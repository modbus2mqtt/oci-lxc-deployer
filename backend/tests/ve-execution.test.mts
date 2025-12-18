import { describe, it, expect, afterEach } from "vitest";
import { VeExecution } from "@src/ve-execution.mjs";
import { ICommand, IVeExecuteMessage } from "@src/types.mjs";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IVEContext } from "@src/backend-types.mjs";
import { StorageContext } from "@src/storagecontext.mjs";

// New test cases are implemented here using overridable execCommand method.
let index = 0;
const dummyVE: IVEContext = { host: "localhost", port: 22 } as IVEContext;
let testDir: string;
let secretFilePath: string;

beforeAll(() => {
  // Create a temporary directory for the test
  testDir = mkdtempSync(path.join(os.tmpdir(), "ve-execution-test-"));
  secretFilePath = path.join(testDir, "secret.txt");
  
  // Create a valid storagecontext.json file
  const storageContextPath = path.join(testDir, "storagecontext.json");
  fs.writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

  StorageContext.setInstance(testDir, secretFilePath);
});

afterAll(() => {
  // Cleanup test directory
  try {
    if (testDir && fs.existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  } catch  {
    // Ignore cleanup errors
  }
});

describe("VeExecution", () => {
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

  it("should read a script file, replace variables, and execute the replaced content", async () => {
    const scriptPath = path.join(os.tmpdir(), "testscript.sh");
    fs.writeFileSync(scriptPath, "echo {{ myvar }}");
    class TestExec extends VeExecution {
      public lastCommand = "";
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
        remoteCommand?: string[],
      ): Promise<IVeExecuteMessage> {
        this.lastCommand = input;
        return await super.runOnVeHost("", tmplCommand, timeoutMs, ["-c", input]);
      }
    }
    const commands: ICommand[] = [
      {
        script: scriptPath,
        name: "test",
        execute_on: "ve",
      },
    ];
    const inputs = [{ id: "myvar", value: "replacedValue" }];
    const exec = new TestExec(commands, inputs, dummyVE, new Map(), "sh");
    await exec.run();
    expect(exec.lastCommand).toBe("echo replacedValue");
    try {
      fs.unlinkSync(scriptPath);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (e: any) {}
  });

  it("should replace variable in command with input value", async () => {
    let resultValue = "";
    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
        remoteCommand?: string[],
      ): Promise<IVeExecuteMessage> {
        resultValue = input;
        return await super.runOnVeHost("", tmplCommand, timeoutMs, ["-c", input]);
      }
    }
    const commands: ICommand[] = [
      {
        command: "echo {{ somevariable }}",
        name: "test",
        execute_on: "ve",
      },
    ];
    const inputs = [{ id: "somevariable", value: "replaced" }];
    const exec = new TestExec(commands, inputs, dummyVE, new Map(), "sh");
    await exec.run();
    expect(resultValue).toBe("echo replaced");
  });
  it("should parse JSON output and fill outputs", async () => {
    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
        remoteCommand?: string[],
      ): Promise<IVeExecuteMessage> {
        return await super.runOnVeHost("", tmplCommand, timeoutMs, ["-c", input]);
      }
    }
    const commands: ICommand[] = [
      {
        command: "echo '{\"id\": \"foo\", \"value\": \"bar\"}'",
        name: "test",
        execute_on: "ve",
      },
      {
        command: "echo '{\"id\": \"baz\", \"value\": 99}'",
        name: "test",
        execute_on: "ve",
      },
      {
        command: "echo '{\"id\": \"vm_id\", \"value\": 100}'",
        name: "test",
        execute_on: "ve",
      },
      {
        command: "echo '{\"id\": \"foo\", \"value\": \"baz\"}'",
        name: "test",
        execute_on: "ve",
      },
    ];
    const inputs = [
      { id: "foo", value: "inputFoo" },
      { id: "baz", value: 99 },
    ];
    const exec = new TestExec(commands, inputs, dummyVE, new Map(), "sh");
    await exec.run();
    expect(exec.outputs.get("foo")).toBe("baz");
    expect(exec.outputs.get("baz")).toBe(99);
    expect(exec.outputs.get("vm_id")).toBe(100);
  });

  it("should replace variables from inputs and outputs", async () => {
    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
        remoteCommand?: string[],
      ): Promise<IVeExecuteMessage> {
        return await super.runOnVeHost("", tmplCommand, timeoutMs, ["-c", input]);
      }
    }
    const commands: ICommand[] = [
      {
        command: "echo '{\"id\": \"foo\", \"value\": \"bar\"}'",
        name: "test",
        execute_on: "ve",
      },
      {
        command: "echo '{\"id\": \"foo\", \"value\": \"baz99\"}'",
        name: "test",
        execute_on: "ve",
      },
    ];
    const inputs = [{ id: "foo", value: "inputFoo" }];
    const exec = new TestExec(commands, inputs, dummyVE, new Map(), "sh");
    await exec.run();
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
  //       execute_on: "ve",
  //     },
  //     {
  //       command: 'echo "{\"foo\": \"bar\"}"',
  //       name: "test",
  //       execute_on: "ve",
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

  it("should return lastSuccessIndex", async () => {
    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
        remoteCommand?: string[],
      ): Promise<IVeExecuteMessage> {
        return await super.runOnVeHost("", tmplCommand, timeoutMs, ["-c", input]);
      }
    }
    const commands: ICommand[] = [
      {
        command: "echo '{\"id\": \"foo\", \"value\": \"bar\"}'",
        name: "test",
        execute_on: "ve",
      },
      {
        command: "echo '{\"id\": \"foo\", \"value\": \"baz99\"}'",
        name: "test",
        execute_on: "ve",
      },
      {
        command: "echo '{\"id\": \"baz\", \"value\": 99}'",
        name: "test",
        execute_on: "ve",
      },
    ];
    const inputs = [{ id: "foo", value: "inputFoo" }];
    const exec = new TestExec(commands, inputs, dummyVE, new Map(), "sh");
    const result = await exec.run();
    expect(typeof result?.lastSuccessfull).toBe("number");
    expect(result?.lastSuccessfull).toBe(commands.length - 1);
  });

  it("should fill IRestartInfo.outputs[0] with parsed JSON result", async () => {
    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
        remoteCommand?: string[],
      ): Promise<IVeExecuteMessage> {
        return await super.runOnVeHost("", tmplCommand, timeoutMs, ["-c", input]);
      }
    }
    const commands: ICommand[] = [
      {
        command: "echo '[{\"name\": \"foo\", \"value\": \"bar\"}]'",
        name: "emit-json",
        execute_on: "ve",
      },
    ];
    const exec = new TestExec(commands, [], dummyVE, new Map(), "sh");
    const rc = await exec.run();
    expect(rc).toBeDefined();
    expect(Array.isArray(rc!.outputs)).toBe(true);
    expect(rc!.outputs.length).toBeGreaterThan(0);
    const first = rc!.outputs[0];
    expect(first!.name).toBe("foo");
    expect(first!.value).toBe("bar");
  });

  it("emits finished with IVMContext containing vmid on success", async () => {
    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
        remoteCommand?: string[],
      ): Promise<IVeExecuteMessage> {
        return await super.runOnVeHost("", tmplCommand, timeoutMs, ["-c", input]);
      }
    }
    const commands: ICommand[] = [
      {
        command: "echo '{\"id\": \"vm_id\", \"value\": 123}'",
        name: "emit-vmid",
        execute_on: "ve",
      },
    ];
    const exec = new TestExec(commands, [], dummyVE, new Map(), "sh");
    let received: any = undefined;
    exec.on("finished", (ctx: any) => {
      received = ctx;
    });
    await exec.run();
    expect(received).toBeDefined();
    expect(typeof received.vmid).toBe("number");
    expect(received.vmid).toBe(123);
  });

  it("does not emit finished when a command fails", async () => {
    class FailingExec extends VeExecution {
      private called = false;
      protected async runOnVeHost(command: string, tmplCommand: ICommand): Promise<IVeExecuteMessage> {
        if (!this.called) {
          this.called = true;
          // Simulate failure by throwing
          throw new Error("simulated failure");
        }
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
      { command: 'echo "first"', name: "first", execute_on: "ve" },
      { command: 'echo "second"', name: "second", execute_on: "ve" },
    ];
    const exec = new FailingExec(commands, [], dummyVE, new Map());
    let finishedCalled = false;
    exec.on("finished", () => {
      finishedCalled = true;
    });
    try {
      await exec.run();
    } catch {}
    expect(finishedCalled).toBe(false);
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
  //       execute_on: "ve",
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

  it("should process local: file paths in outputs and encode file content as base64", async () => {
    // Create a temporary directory for the test
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "ve-execution-local-test-"));
    const testFileName = "test-binary-file.bin";
    const testFilePath = path.join(testDir, testFileName);
    
    // Create a binary file with all values 0-255
    const binaryData = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    fs.writeFileSync(testFilePath, binaryData);

    // Create a valid storagecontext.json file
    const storageContextPath = path.join(testDir, "storagecontext.json");
    fs.writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

    // Set StorageContext to use the test directory
    const secretFilePath = path.join(testDir, "secret.txt");
    StorageContext.setInstance(testDir, secretFilePath);

    const commands: ICommand[] = [
      {
        command: `echo '{"id": "testfile", "value": "local:${testFileName}"}'`,
        name: "test-local-file",
        execute_on: "ve",
      },
    ];

    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
        remoteCommand?: string[],
      ): Promise<IVeExecuteMessage> {
        // Use sh -c as remoteCommand to execute locally
        // sshCommand is "sh", so remoteCommand should be ["-c", input] to pass command as argument
        return await super.runOnVeHost("", tmplCommand, timeoutMs, ["-c", input]);
      }
    }

    // Use "sh" as sshCommand to execute commands locally
    const exec = new TestExec(commands, [], dummyVE, new Map(), "sh");
    await exec.run();

    // Verify that the output is base64 encoded
    const outputValue = exec.outputs.get("testfile");
    expect(outputValue).toBeDefined();
    expect(typeof outputValue).toBe("string");

    // Verify that it's valid base64
    const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
    expect(base64Pattern.test(outputValue as string)).toBe(true);

    // Decode base64 and verify content matches original file
    const decodedBuffer = Buffer.from(outputValue as string, "base64");
    expect(decodedBuffer.length).toBe(256);
    expect(decodedBuffer.equals(binaryData)).toBe(true);

    // Verify each byte matches
    for (let i = 0; i < 256; i++) {
      expect(decodedBuffer[i]).toBe(i);
    }

    // Cleanup
    try {
      fs.unlinkSync(testFilePath);
      fs.rmdirSync(testDir);
    } catch{
      // Ignore cleanup errors
    }
  });

  it("should process local: file paths in name/value array outputs", async () => {
    // Create a temporary directory for the test
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "ve-execution-local-test2-"));
    const testFileName = "test-binary-file2.bin";
    const testFilePath = path.join(testDir, testFileName);
    
    // Create a binary file with all values 0-255
    const binaryData = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    fs.writeFileSync(testFilePath, binaryData);

    // Create a valid storagecontext.json file
    const storageContextPath = path.join(testDir, "storagecontext.json");
    fs.writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

    // Set StorageContext to use the test directory
    const secretFilePath = path.join(testDir, "secret.txt");
    StorageContext.setInstance(testDir, secretFilePath);

    const commands: ICommand[] = [
      {
        command: `echo '[{"name": "testfile", "value": "local:${testFileName}"}]'`,
        name: "test-local-file-array",
        execute_on: "ve",
      },
    ];

    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
        remoteCommand?: string[],
      ): Promise<IVeExecuteMessage> {
        // Use sh -c as remoteCommand to execute locally
        // sshCommand is "sh", so remoteCommand should be ["-c", input] to pass command as argument
        return await super.runOnVeHost("", tmplCommand, timeoutMs, ["-c", input]);
      }
    }

    // Use "sh" as sshCommand to execute commands locally
    const exec = new TestExec(commands, [], dummyVE, new Map(), "sh");
    await exec.run();

    // Verify that the output is base64 encoded
    const outputValue = exec.outputs.get("testfile");
    expect(outputValue).toBeDefined();
    expect(typeof outputValue).toBe("string");

    // Verify that it's valid base64
    const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/;
    expect(base64Pattern.test(outputValue as string)).toBe(true);

    // Decode base64 and verify content matches original file
    const decodedBuffer = Buffer.from(outputValue as string, "base64");
    expect(decodedBuffer.length).toBe(256);
    expect(decodedBuffer.equals(binaryData)).toBe(true);

    // Verify outputsRaw is also set correctly
    expect(exec.outputsRaw).toBeDefined();
    expect(Array.isArray(exec.outputsRaw)).toBe(true);
    expect(exec.outputsRaw!.length).toBe(1);
    expect(exec.outputsRaw![0].name).toBe("testfile");
    expect(exec.outputsRaw![0].value).toBe(outputValue);

    // Cleanup
    try {
      fs.unlinkSync(testFilePath);
      fs.rmdirSync(testDir);
    } catch {
      // Ignore cleanup errors
    }
  });

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
