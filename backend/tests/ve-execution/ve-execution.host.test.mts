// TESTING STRATEGY FOR execute_on: "host:hostname"
//
// We test the logic, not the external dependencies.
// External dependencies (SSH, LXC) are executed locally via ExecutionMode.TEST.
//
// IMPORTANT: ExecutionMode.TEST is used to avoid SSH calls.
// runOnVeHost and runOnLxc will then automatically execute locally (see buildExecutionArgs and runOnLxc).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VeExecution } from "@src/ve-execution/ve-execution.mjs";
import { ICommand, IVeExecuteMessage } from "@src/types.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import {
  getNextMessageIndex,
  ExecutionMode,
} from "@src/ve-execution/ve-execution-constants.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";

describe("VeExecution host: flow", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    env.initPersistence({ enableCache: false });
  });

  afterEach(() => {
    env.cleanup();
  });

  /**
   * Helper function to set up VE context with default values.
   */
  function setupVEContext(): void {
    const pm = PersistenceManager.getInstance();
    const storage = pm.getContextManager();
    storage.setVEContext({
      host: "localhost",
      port: 22,
      getStorageContext: () => storage,
      getKey: () => "ve_localhost",
    });
  }

  /**
   * Helper function to set up VM context with default values.
   */
  function setupVMContext(
    vmid: number,
    vekey: string,
    outputs: Record<string, string | number | boolean>,
  ): void {
    const pm = PersistenceManager.getInstance();
    const storage = pm.getContextManager();
    storage.setVMContext({
      vmid,
      vekey,
      outputs,
      getKey: () => `vm_${vmid}`,
    });
  }

  /**
   * Test case 1: Single command with execute_on: "host:hostname"
   *
   * NOTE: A single command with execute_on: "host:hostname" is treated as a template
   * and calls executeTemplateOnHost, not executeOnHost.
   *
   * TO TEST:
   * - executeTemplateOnHost is called
   * - Command is executed on LXC (via runOnLxc)
   * - ExecutionMode.TEST leads to local execution without SSH
   */
  it("executes command on LXC via executeTemplateOnHost", async () => {
    setupVEContext();
    setupVMContext(101, "ve_localhost", { hostname: "apphost", pve: "pve-1" });

    const command: ICommand = {
      name: "deploy",
      command: "echo 'hello'",
      execute_on: "host:apphost",
    };

    // Create VeExecution with ExecutionMode.TEST instead of ExecutionMode.PRODUCTION
    // runOnVeHost and runOnLxc will then automatically execute locally
    // Mock runOnVeHost for probe (write-vmids-json.sh) - it can use a command instead of a script
    class TestExec extends VeExecution {
      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
      ): Promise<IVeExecuteMessage> {
        // Mock probe: return VM IDs directly via command instead of script
        // Check if this is the write-vmids-json.sh probe script
        if (
          tmplCommand.script &&
          tmplCommand.script.includes("write-vmids-json.sh")
        ) {
          return {
            stderr: "",
            result: JSON.stringify([
              { hostname: "apphost", pve: "pve-1", vmid: 101 },
            ]),
            exitCode: 0,
            command: "write-vmids",
            execute_on: "ve",
            index: 0,
          } as IVeExecuteMessage;
        }
        // For other calls, execute locally using ExecutionMode.TEST
        return await super.runOnVeHost(input, tmplCommand, timeoutMs);
      }
    }

    const pm = PersistenceManager.getInstance();
    const veContext = pm.getContextManager().getVEContextByKey("ve_localhost");
    if (!veContext) {
      throw new Error("VE context not found for key: ve_localhost");
    }
    const exec = new TestExec(
      [command],
      [{ id: "vm_id", value: 101 }],
      veContext,
      undefined,
      undefined,
      ExecutionMode.TEST,
    );

    const rc = await exec.run();

    // Assertions
    expect(rc).toBeDefined();
    expect(rc?.lastSuccessfull).toBe(0);
  });

  /**
   * Test case 2: Error when VMContext not found
   * NOTE: executeTemplateOnHost does not perform PVE/VMID validation (that's only in executeOnHost).
   * It just looks up the VMContext by hostname. If not found, it throws an error.
   * The error is caught in VeExecution.run and emitted as an error message, then the loop breaks.
   */
  it("fails when VMContext not found for hostname", async () => {
    setupVEContext();
    // Don't set up VM context - it should fail when looking up by hostname
    const command: ICommand = {
      name: "deploy",
      command: "echo 'hello'",
      execute_on: "host:apphost",
    };

    const pm = PersistenceManager.getInstance();
    const veContext = pm.getContextManager().getVEContextByKey("ve_localhost");
    if (!veContext) {
      throw new Error("VE context not found for key: ve_localhost");
    }
    const exec = new VeExecution(
      [command],
      [],
      veContext,
      undefined,
      undefined,
      ExecutionMode.TEST,
    );

    // Listen for error messages
    const messages: any[] = [];
    exec.on("message", (msg) => {
      messages.push(msg);
    });

    const rc = await exec.run();

    // The error is caught and emitted as a message, then run returns undefined
    // because no commands were successfully executed
    expect(rc).toBeUndefined();
    // Verify that an error message was emitted
    const errorMessages = messages.filter(
      (m) => m.exitCode === -1 || m.exitCode < 0,
    );
    expect(errorMessages.length).toBeGreaterThan(0);
    expect(
      errorMessages.some((m) =>
        m.stderr?.includes("VMContext for apphost not found"),
      ),
    ).toBe(true);
  });

  /**
   * Test case 4: Variable replacement uses vmctx.outputs (not outputs from parent)
   */
  it("replaces host command variables using vmctx.outputs (not outputs)", async () => {
    setupVEContext();
    setupVMContext(101, "ve_localhost", {
      hostname: "apphost",
      pve: "pve-1",
      app_name: "myapp",
    });
    const command: ICommand = {
      name: "deploy",
      command: "echo '{{app_name}}-on-{{hostname}}'",
      execute_on: "host:apphost",
    };

    class TestExec extends VeExecution {
      public captured: string | undefined;

      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
      ): Promise<IVeExecuteMessage> {
        // Mock probe: return VM IDs directly via command instead of script
        // Check if this is the write-vmids-json.sh probe script
        if (
          tmplCommand.script &&
          tmplCommand.script.includes("write-vmids-json.sh")
        ) {
          return {
            stderr: "",
            result: JSON.stringify([
              { hostname: "apphost", pve: "pve-1", vmid: 101 },
            ]),
            exitCode: 0,
            command: "write-vmids",
            execute_on: "ve",
            index: 0,
          } as IVeExecuteMessage;
        }
        return await super.runOnVeHost(input, tmplCommand, timeoutMs);
      }

      protected async runOnLxc(
        vm_id: string | number,
        command: string,
        tmplCommand: ICommand,
        timeoutMs?: number,
      ): Promise<IVeExecuteMessage> {
        // Capture the command to verify variable replacement
        this.captured = command;
        return await super.runOnLxc(vm_id, command, tmplCommand, timeoutMs);
      }
    }

    // Provide an input that would differ from vmctx.outputs to ensure outputs wins
    const pm = PersistenceManager.getInstance();
    const veContext = pm.getContextManager().getVEContextByKey("ve_localhost");
    if (!veContext) {
      throw new Error("VE context not found for key: ve_localhost");
    }
    const exec = new TestExec(
      [command],
      [{ id: "app_name", value: "inputApp" }],
      veContext,
      undefined,
      undefined,
      ExecutionMode.TEST,
    );

    const rc = await exec.run();
    expect(rc).toBeDefined();
    expect(rc?.lastSuccessfull).toBe(0);
    // Verify that vmctx.outputs values are used (myapp), not parent outputs (inputApp)
    expect(exec.captured).toBeDefined();
    expect(exec.captured).toContain("myapp-on-apphost");
    expect(exec.captured).not.toContain("inputApp");
  });

  /**
   * Test case 5: vmctx.outputs.vm_id is preferred over outputs.vm_id
   */
  it("prefers vmctx.outputs.vm_id over outputs.vm_id", async () => {
    setupVEContext();
    setupVMContext(101, "ve_localhost", {
      hostname: "apphost",
      pve: "pve-1",
      vm_id: 101,
    });

    const command: ICommand = {
      name: "deploy",
      command: "echo '{{vm_id}}'",
      execute_on: "host:apphost",
    };

    class TestExec extends VeExecution {
      public captured: string | undefined;

      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
      ): Promise<IVeExecuteMessage> {
        // Mock probe: return VM IDs directly via command instead of script
        // Check if this is the write-vmids-json.sh probe script
        if (
          tmplCommand.script &&
          tmplCommand.script.includes("write-vmids-json.sh")
        ) {
          return {
            stderr: "",
            result: JSON.stringify([
              { hostname: "apphost", pve: "pve-1", vmid: 101 },
            ]),
            exitCode: 0,
            command: "write-vmids",
            execute_on: "ve",
            index: 0,
          } as IVeExecuteMessage;
        }
        return await super.runOnVeHost(input, tmplCommand, timeoutMs);
      }

      protected async runOnLxc(
        vm_id: string | number,
        command: string,
        tmplCommand: ICommand,
        timeoutMs?: number,
      ): Promise<IVeExecuteMessage> {
        // Capture the command to verify variable replacement
        this.captured = command;
        return await super.runOnLxc(vm_id, command, tmplCommand, timeoutMs);
      }
    }

    const pm = PersistenceManager.getInstance();
    const veContext = pm.getContextManager().getVEContextByKey("ve_localhost");
    if (!veContext) {
      throw new Error("VE context not found for key: ve_localhost");
    }
    const exec = new TestExec(
      [command],
      [{ id: "vm_id", value: "999" }],
      veContext,
      undefined,
      undefined,
      ExecutionMode.TEST,
    );

    const rc = await exec.run();
    expect(rc).toBeDefined();
    expect(rc?.lastSuccessfull).toBe(0);
    // Verify that vmctx.outputs.vm_id (101) is used, not parent outputs.vm_id (999)
    expect(exec.captured).toBeDefined();
    expect(exec.captured).toContain("101");
    expect(exec.captured).not.toContain("999");
  });

  /**
   * Test case 6: Template with properties and vmContext inputs
   */
  it("executes template on host with properties and vmContext inputs (using sh)", async () => {
    setupVEContext();
    // Note: vm_id should NOT be in vmContext.outputs - it comes from vmctx.vmid
    // and will be added as input automatically by executeTemplateOnHost
    setupVMContext(101, "ve_localhost", {
      hostname: "testhost",
      pve: "pve-1",
      vmctx_output: "value-from-vmcontext", // This should be available in the script
    });

    // Create a template with properties command and script command
    // The script should have access to:
    // 1. A property from the properties command: "property_value"
    // 2. An output from vmContext: "vmctx_output"
    const templateCommands: ICommand[] = [
      {
        name: "Set Properties",
        properties: [{ id: "property_value", value: "value-from-properties" }],
        execute_on: "host:testhost",
      },
      {
        name: "Test Script",
        command:
          "echo 'property_value={{property_value}} vmctx_output={{vmctx_output}}'",
        execute_on: "host:testhost",
      },
    ];

    class TestExec extends VeExecution {
      public capturedCommands: string[] = [];
      public capturedVmId: number | undefined;
      public capturedInputs: Record<string, string | number | boolean> = {};

      protected async runOnVeHost(
        input: string,
        tmplCommand: ICommand,
        timeoutMs = 300000,
      ): Promise<IVeExecuteMessage> {
        // Mock probe: return VM IDs directly via command instead of script
        // Check if this is the write-vmids-json.sh probe script
        if (
          tmplCommand.script &&
          tmplCommand.script.includes("write-vmids-json.sh")
        ) {
          return {
            stderr: "",
            result: JSON.stringify([
              { hostname: "testhost", pve: "pve-1", vmid: 101 },
            ]),
            exitCode: 0,
            command: "write-vmids",
            execute_on: "ve",
            index: 0,
          } as IVeExecuteMessage;
        }
        return await super.runOnVeHost(input, tmplCommand, timeoutMs);
      }

      protected async runOnLxc(
        vmid: string | number,
        command: string,
        tmplCommand: ICommand,
        timeoutMs?: number,
      ): Promise<IVeExecuteMessage> {
        void timeoutMs;
        this.capturedVmId = Number(vmid);
        this.capturedCommands.push(command);
        // Capture inputs from the nested VeExecution instance
        // Note: inputs are stored in the variableResolver, we need to access them differently
        // For now, just capture the command which should have variables replaced

        // Simulate command execution with variable replacement
        // The command should already have variables replaced by VeExecution
        return {
          stderr: "",
          result: command,
          exitCode: 0,
          command: tmplCommand.name,
          execute_on: "lxc",
          index: getNextMessageIndex(),
        } as IVeExecuteMessage;
      }
    }

    const pm = PersistenceManager.getInstance();
    const veContext = pm.getContextManager().getVEContextByKey("ve_localhost");
    if (!veContext) {
      throw new Error("VE context not found for key: ve_localhost");
    }
    const exec = new TestExec(
      templateCommands,
      [],
      veContext,
      undefined,
      undefined,
      ExecutionMode.TEST, // Use ExecutionMode.TEST instead of ExecutionMode.PRODUCTION
    );

    const rc = await exec.run();

    expect(rc).toBeDefined();
    expect(rc?.lastSuccessfull).toBe(1); // Both commands should succeed
    expect(exec.capturedVmId).toBe(101);

    // Check that the script command was executed
    expect(exec.capturedCommands.length).toBe(1); // Only the script command, properties is handled separately

    // Check that the script command was executed with both values replaced
    const scriptCommand = exec.capturedCommands[0];
    expect(scriptCommand).toBeDefined();
    expect(scriptCommand).toContain("property_value=value-from-properties");
    expect(scriptCommand).toContain("vmctx_output=value-from-vmcontext");
  });
});
