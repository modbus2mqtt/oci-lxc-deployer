import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import { VeExecution } from "@src/ve-execution/ve-execution.mjs";
import { ICommand, IVeExecuteMessage } from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

// New test cases are implemented here using overridable execCommand method.
let index = 0;
const dummyVE: IVEContext = { host: "localhost", port: 22 } as IVEContext;
let env: TestEnvironment;
let persistenceHelper: TestPersistenceHelper;

beforeAll(() => {
  env = createTestEnvironment(import.meta.url, {
    jsonIncludePatterns: [],
  });
  env.initPersistence({ enableCache: false });
  persistenceHelper = new TestPersistenceHelper({
    repoRoot: env.repoRoot,
    localRoot: env.localDir,
    jsonRoot: env.jsonDir,
    schemasRoot: env.schemaDir,
  });
});

afterAll(() => {
  env.cleanup();
});

describe("VeExecution", () => {
  // Note: Variable resolution tests are now in variable-resolver.test.mts
  // Note: Properties command tests are now in ve-execution-command-processor.test.mts

  it("should read a script file, replace variables, and execute the replaced content", async () => {
    class TestExec extends VeExecution {
      public lastCommand = "";
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
      ): Promise<IVeExecuteMessage> {
        this.lastCommand = input;
        return await super.runOnVeHost(
          input,
          tmplCommand,
          timeoutMs,
        );
      }
    }
    const commands: ICommand[] = [
      {
        script: "testscript.sh",
        scriptContent: "echo {{ myvar }}",
        name: "test",
        execute_on: "ve",
      },
    ];
    const inputs = [{ id: "myvar", value: "replacedValue" }];
    const exec = new TestExec(commands, inputs, dummyVE, new Map(), undefined, ExecutionMode.TEST);
    await exec.run();
    expect(exec.lastCommand).toBe("echo replacedValue");
  });

  it("should replace variable in command with input value", async () => {
    let resultValue = "";
    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
      ): Promise<IVeExecuteMessage> {
        resultValue = input;
        return await super.runOnVeHost(
          input,
          tmplCommand,
          timeoutMs,
        );
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
    const exec = new TestExec(commands, inputs, dummyVE, new Map(), undefined, ExecutionMode.TEST);
    await exec.run();
    expect(resultValue).toBe("echo replaced");
  });
  it("should parse JSON output and fill outputs", async () => {
    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
      ): Promise<IVeExecuteMessage> {
        return await super.runOnVeHost(
          input,
          tmplCommand,
          timeoutMs,
        );
      }
    }
    const commands: ICommand[] = [
      {
        command: 'echo \'{"id": "foo", "value": "bar"}\'',
        name: "test",
        execute_on: "ve",
      },
      {
        command: 'echo \'{"id": "baz", "value": 99}\'',
        name: "test",
        execute_on: "ve",
      },
      {
        command: 'echo \'{"id": "vm_id", "value": 100}\'',
        name: "test",
        execute_on: "ve",
      },
      {
        command: 'echo \'{"id": "foo", "value": "baz"}\'',
        name: "test",
        execute_on: "ve",
      },
    ];
    const inputs = [
      { id: "foo", value: "inputFoo" },
      { id: "baz", value: 99 },
    ];
    const exec = new TestExec(commands, inputs, dummyVE, new Map(), undefined, ExecutionMode.TEST);
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
      ): Promise<IVeExecuteMessage> {
        return await super.runOnVeHost(
          input,
          tmplCommand,
          timeoutMs,
        );
      }
    }
    const commands: ICommand[] = [
      {
        command: 'echo \'{"id": "foo", "value": "bar"}\'',
        name: "test",
        execute_on: "ve",
      },
      {
        command: 'echo \'{"id": "foo", "value": "baz99"}\'',
        name: "test",
        execute_on: "ve",
      },
    ];
    const inputs = [{ id: "foo", value: "inputFoo" }];
    const exec = new TestExec(commands, inputs, dummyVE, new Map(), undefined, ExecutionMode.TEST);
    await exec.run();
    expect(exec.outputs.get("foo")).toBe("baz99");
  });

  it("should process multiple outputs from JSON array correctly", async () => {
    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
      ): Promise<IVeExecuteMessage> {
        // Mock runOnVeHost to simulate command execution and output parsing
        // The command should output JSON with template_path and ostype
        // Note: Using a value without "local:" prefix to avoid file reading in tests
        const expectedOutput = '[{"id":"template_path","value":"vztmpl/alpine-3.22-default_20250617_amd64.tar.xz"},{"id":"ostype","value":"alpine"}]';
        
        // Instead of accessing private properties, just call super which will handle output parsing
        // For this test, we need to simulate the command output, so we'll use the actual execution
        // but capture the output first
        const result = await super.runOnVeHost(
          `echo '${expectedOutput}'`,
          tmplCommand,
          timeoutMs,
        );
        return result;
      }
    }
    // Simulate get-latest-os-template.sh output: array with template_path and ostype
    // This matches the exact format from get-latest-os-template.sh
    const commands: ICommand[] = [
      {
        command: 'echo \'[{"id":"template_path","value":"local:vztmpl/alpine-3.22-default_20250617_amd64.tar.xz"},{"id":"ostype","value":"alpine"}]\'',
        name: "get-latest-os-template",
        execute_on: "ve",
        outputs: ["template_path", "ostype"],
      },
    ];
    const inputs: Array<{ id: string; value: string | number | boolean }> = [];
    const exec = new TestExec(commands, inputs, dummyVE, new Map(), undefined, ExecutionMode.TEST);
    await exec.run();
    
    // Verify both outputs were added to the map
    expect(exec.outputs.has("template_path")).toBe(true);
    expect(exec.outputs.has("ostype")).toBe(true);
    expect(exec.outputs.get("template_path")).toBe("vztmpl/alpine-3.22-default_20250617_amd64.tar.xz");
    expect(exec.outputs.get("ostype")).toBe("alpine");
    
    // Verify that both outputs are present
    expect(exec.outputs.size).toBeGreaterThanOrEqual(2);
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
      ): Promise<IVeExecuteMessage> {
        return await super.runOnVeHost(
          input,
          tmplCommand,
          timeoutMs,
        );
      }
    }
    const commands: ICommand[] = [
      {
        command: 'echo \'{"id": "foo", "value": "bar"}\'',
        name: "test",
        execute_on: "ve",
      },
      {
        command: 'echo \'{"id": "foo", "value": "baz99"}\'',
        name: "test",
        execute_on: "ve",
      },
      {
        command: 'echo \'{"id": "baz", "value": 99}\'',
        name: "test",
        execute_on: "ve",
      },
    ];
    const inputs = [{ id: "foo", value: "inputFoo" }];
    const exec = new TestExec(commands, inputs, dummyVE, new Map(), undefined, ExecutionMode.TEST);
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
      ): Promise<IVeExecuteMessage> {
        return await super.runOnVeHost(
          input,
          tmplCommand,
          timeoutMs,
        );
      }
    }
    const commands: ICommand[] = [
      {
        command: 'echo \'[{"name": "foo", "value": "bar"}]\'',
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
      ): Promise<IVeExecuteMessage> {
        return await super.runOnVeHost(
          input,
          tmplCommand,
          timeoutMs,
        );
      }
    }
    const commands: ICommand[] = [
      {
        command: 'echo \'{"id": "vm_id", "value": 123}\'',
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
      protected async runOnVeHost(
        command: string,
        tmplCommand: ICommand,
      ): Promise<IVeExecuteMessage> {
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
    const testFileName = "test-binary-file.bin";

    // Create a binary file with all values 0-255
    const binaryData = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    persistenceHelper.writeBinarySync(
      Volume.LocalRoot,
      testFileName,
      binaryData,
    );

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
      ): Promise<IVeExecuteMessage> {
        // ExecutionMode.TEST is used, so commands execute locally
        return await super.runOnVeHost(
          input,
          tmplCommand,
          timeoutMs,
        );
      }
    }

    // Use ExecutionMode.TEST to execute commands locally
    const exec = new TestExec(commands, [], dummyVE, new Map(), undefined, ExecutionMode.TEST);
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
  });

  it("should process local: file paths in name/value array outputs", async () => {
    const testFileName = "test-binary-file2.bin";

    // Create a binary file with all values 0-255
    const binaryData = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    persistenceHelper.writeBinarySync(
      Volume.LocalRoot,
      testFileName,
      binaryData,
    );

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
      ): Promise<IVeExecuteMessage> {
        // ExecutionMode.TEST is used, so commands execute locally
        return await super.runOnVeHost(
          input,
          tmplCommand,
          timeoutMs,
        );
      }
    }

    // Use ExecutionMode.TEST to execute commands locally
    const exec = new TestExec(commands, [], dummyVE, new Map(), undefined, ExecutionMode.TEST);
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

    // Verify outputsRaw is also set correctly (accessing private field directly)
    const outputsRaw = (exec as any).outputsRaw;
    expect(outputsRaw).toBeDefined();
    expect(Array.isArray(outputsRaw)).toBe(true);
    expect(outputsRaw!.length).toBe(1);
    expect(outputsRaw![0].name).toBe("testfile");
    expect(outputsRaw![0].value).toBe(outputValue);
  });

  afterEach(() => {
    // Clean up sshconfig.json after each test
    try {
      persistenceHelper.removeSync(Volume.LocalRoot, "sshconfig.json");
    } catch {}
  });

  it("should collect list variables and format them as key=value lines", async () => {
    const commands: ICommand[] = [
      {
        command: "echo '{{ volumes }}'",
        name: "test-list-variables",
        execute_on: "ve",
      },
    ];

    const inputs: { id: string; value: string | number | boolean }[] = [
      { id: "volume1", value: "/var/lib/myapp/data" },
      { id: "volume2", value: "/var/lib/myapp/logs" },
    ];

    let capturedCommand = "";

    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand
      ): Promise<IVeExecuteMessage> {
        // Capture the processed command to verify variable replacement
        capturedCommand = input;
        return {
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on ?? "",
          exitCode: 0,
          result: "OK",
          stderr: "",
          commandtext: input,
        };
      }
    }

    const exec = new TestExec(commands, inputs, dummyVE, new Map(), "/bin/sh");

    // Set up outputs with list.volumes.* pattern
    exec.outputs.set("list.volumes.volume1", "/var/lib/myapp/data");
    exec.outputs.set("list.volumes.volume2", "/var/lib/myapp/logs");

    // Execute the command
    await exec.run();
    
    // The command should have volumes replaced with key=value lines
    const expectedOutput = `volume1=/var/lib/myapp/data
volume2=/var/lib/myapp/logs`;
    
    expect(capturedCommand).toContain(expectedOutput);
  });

  it("should handle list variables from outputs, inputs, and defaults with priority", async () => {
    const commands: ICommand[] = [
      {
        command: "echo '{{ envvars }}'",
        name: "test-list-variables-priority",
        execute_on: "ve",
      },
    ];

    const inputs: { id: string; value: string | number | boolean }[] = [
      { id: "var1", value: "input-value" },
    ];

    const defaults = new Map<string, string | number | boolean>();
    defaults.set("list.envvars.var2", "default-value");

    let capturedCommand = "";

    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand
      ): Promise<IVeExecuteMessage> {
        capturedCommand = input;
        return {
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on ?? "",
          exitCode: 0,
          result: "OK",
          stderr: "",
          commandtext: input,
        };
      }
    }
    const exec = new TestExec(commands, inputs, dummyVE, defaults, "/bin/sh");

    // Set up outputs with list.envvars.* pattern (highest priority)
    exec.outputs.set("list.envvars.var1", "output-value");
    exec.outputs.set("list.envvars.var2", "output-override");
    exec.outputs.set("list.envvars.var3", "output-only");

    // Execute the command
    await exec.run();
    
    // Outputs should take precedence over inputs and defaults
    // var1 should be from outputs, not inputs
    expect(capturedCommand).toContain("var1=output-value");
    // var2 should be from outputs, not defaults
    expect(capturedCommand).toContain("var2=output-override");
    // var3 should be from outputs only
    expect(capturedCommand).toContain("var3=output-only");
    
    // Should not contain input value
    expect(capturedCommand).not.toContain("input-value");
    // Should not contain default value
    expect(capturedCommand).not.toContain("default-value");
  });

  it("should handle list variables from context with highest priority", () => {
    const commands: ICommand[] = [
      {
        command: "echo '{{ volumes }}'",
        name: "test-list-variables-context",
        execute_on: "ve",
      },
    ];

    const inputs: { id: string; value: string | number | boolean }[] = [];

    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand
      ): Promise<IVeExecuteMessage> {
        return {
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on!,
          exitCode: 0,
          result: "OK",
          stderr: "",
          commandtext: input,
        };
      }
      public callReplaceVarsWithContext(
        str: string,
        ctx: Record<string, any>,
      ): string {
        return this.replaceVarsWithContext(str, ctx);
      }
    }

    const exec = new TestExec(commands, inputs, dummyVE, new Map(), "/bin/sh");

    // Set up outputs
    exec.outputs.set("list.volumes.volume1", "/var/lib/myapp/data");
    exec.outputs.set("list.volumes.volume2", "/var/lib/myapp/logs");

    // Create context with list.volumes.* entries (should take precedence)
    const context = {
      "list.volumes.volume1": "/var/lib/myapp/data-from-context",
      "list.volumes.volume3": "/var/lib/myapp/cache",
    };

    // Replace variables with context
    const processedCommand = exec.callReplaceVarsWithContext(
      "echo '{{ volumes }}'",
      context,
    );

    // The processed command should have the volumes replaced
    // Extract the volumes part (between the quotes)
    const volumesMatch = processedCommand.match(/echo '([^']+)'/);
    expect(volumesMatch).not.toBeNull();
    const volumesContent = volumesMatch![1]!;
    
    // Split by newlines to get individual volume entries
    const volumeLines = volumesContent.split('\n');
    
    // Context values should take precedence
    expect(volumeLines).toContain("volume1=/var/lib/myapp/data-from-context");
    // volume2 should come from outputs (not in context)
    expect(volumeLines).toContain("volume2=/var/lib/myapp/logs");
    // volume3 should come from context
    expect(volumeLines).toContain("volume3=/var/lib/myapp/cache");
    
    // Should not contain the original output value for volume1
    expect(volumeLines).not.toContain("volume1=/var/lib/myapp/data");
  });

  it("should work with example from set-parameters.json template", async () => {
    // This test matches the example template provided:
    // {
    //   "commands": [
    //     {
    //       "command": "[{ \"id\":\"list.volumes.volume1\",\"value\":\"{{ volume1 }}\"},{\"id\":\"list.volumes.volume2\",\"value\":\"{{ volume2 }}\"}]"
    //     }
    //   ],
    //   "outputs": [
    //     { "id": "list.volumes" }
    //   ]
    // }
    
    const commands: ICommand[] = [
      {
        command: "echo '{{ volumes }}'",
        name: "test-example-template",
        execute_on: "ve",
      },
    ];

    const inputs: { id: string; value: string | number | boolean }[] = [
      { id: "volume1", value: "/var/lib/myapp/data" },
      { id: "volume2", value: "/var/lib/myapp/logs" },
    ];

    let capturedCommand = "";

    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand
      ): Promise<IVeExecuteMessage> {
        capturedCommand = input;
        return {
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on as string,
          exitCode: 0,
          result: "OK",
          stderr: "",
          commandtext: input,
        };
      }
    }

    const exec = new TestExec(commands, inputs, dummyVE, new Map(), "/bin/sh");

    // Simulate outputs from set-parameters.json template command
    // The command would output: [{ "id":"list.volumes.volume1","value":"/var/lib/myapp/data"},{"id":"list.volumes.volume2","value":"/var/lib/myapp/logs"}]
    exec.outputs.set("list.volumes.volume1", "/var/lib/myapp/data");
    exec.outputs.set("list.volumes.volume2", "/var/lib/myapp/logs");

    // Execute the command
    await exec.run();
    
    // Extract the volumes content from the command
    const volumesMatch = capturedCommand.match(/echo '([^']+)'/);
    expect(volumesMatch).not.toBeNull();
    const volumesContent = volumesMatch![1]!;
    
    // Split by newlines to get individual volume entries
    const volumeLines = volumesContent.split('\n');
    
    // Verify the expected format: key=value lines
    expect(volumeLines).toContain("volume1=/var/lib/myapp/data");
    expect(volumeLines).toContain("volume2=/var/lib/myapp/logs");
    
    // Verify the format is correct (key=value, one per line)
    expect(volumeLines.length).toBe(2);
    expect(volumeLines[0]).toMatch(/^volume\d+=/);
    expect(volumeLines[1]).toMatch(/^volume\d+=/);
  });
});

