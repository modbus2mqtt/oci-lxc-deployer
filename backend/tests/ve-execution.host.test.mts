import { describe, it, expect, beforeEach } from "vitest";
import { VeExecution } from "@src/ve-execution.mjs";
import { ICommand } from "@src/types.mjs";
import { StorageContext } from "@src/storagecontext.mjs";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { IVEContext } from "@src/backend-types.mjs";

describe("VeExecution host: flow", () => {
  const dummyVE: IVEContext = { host: "localhost", port: 22 } as IVEContext;
  const defaults = new Map<string, string | number | boolean>();

  beforeEach(() => {
    // Reset singleton with a unique temp directory to isolate contexts
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lxc-mgr-host-"));
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    if (!fs.existsSync(path.join(tmpDir, "local")))
      fs.mkdirSync(path.join(tmpDir, "local"), { recursive: true });
    StorageContext.setInstance(tmpDir);
  });

  it("calls write-vmids-json.sh and then runs on matching LXC", async () => {
    const storage = StorageContext.getInstance();
    // Seed a VMContext matching used_vm_ids
    storage.setVMContext({
      vmid: 101,
      vekey: "ve_localhost",
      data: { hostname: "apphost", pve: "pve-1" },
    } as any);

    const command: ICommand = {
      name: "deploy",
      command: "echo 'hello'",
      execute_on: "host:apphost",
    };
    class TestExec extends VeExecution {
      public probePath: string | undefined;
      public lxcCalledWith: { vmid?: number | string; command?: string } = {};
      protected runOnVeHost(
        _input: string,
        tmplCommand: ICommand,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _timeoutMs = 10000,
        remoteCommand?: string[],
      ) {
        if (remoteCommand && remoteCommand.length > 0) {
          this.probePath = remoteCommand[0];
          // Return used_vm_ids payload
          return {
            stderr: "",
            result: JSON.stringify([
              { hostname: "apphost", pve: "pve-1", vmid: 101 },
            ]),
            exitCode: 0,
            command: tmplCommand.name,
            execute_on: tmplCommand.execute_on!,
            index: 0,
          } as any;
        }
        return {
          stderr: "",
          result: "",
          exitCode: 0,
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on!,
          index: 0,
        } as any;
      }
      protected runOnLxc(
        vmid: string | number,
        command: string,
        tmplCommand: ICommand,
      ) {
        this.lxcCalledWith = { vmid, command };
        return {
          stderr: "",
          result: command,
          exitCode: 0,
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on!,
          index: 1,
        } as any;
      }
    }
    const exec = new TestExec([command], [], dummyVE, defaults, "sh");
    const rc = await exec.run();
    expect(rc?.lastSuccessfull).toBe(0);
    expect(exec.probePath).toBeDefined();
    expect(
      exec.probePath!.endsWith(
        path.join("json", "shared", "scripts", "write-vmids-json.sh"),
      ),
    ).toBe(true);
    expect(exec.lxcCalledWith.vmid).toBe(101);
    expect(exec.lxcCalledWith.command).toContain("echo 'hello'");
  });

  it("fails when PVE differs between probe and VMContext", async () => {
    const storage = StorageContext.getInstance();
    storage.setVMContext({
      vmid: 101,
      vekey: "ve_localhost",
      data: { hostname: "apphost", pve: "pve-2" },
    } as any);
    const command: ICommand = {
      name: "deploy",
      command: "echo 'hello'",
      execute_on: "host:apphost",
    };
    class TestExec extends VeExecution {
      public lxcCalled = false;
      protected runOnVeHost(
        _input: string,
        tmplCommand: ICommand,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _timeoutMs = 10000,
        remoteCommand?: string[],
      ) {
        if (remoteCommand && remoteCommand.length > 0) {
          return {
            stderr: "",
            result: JSON.stringify([
              { hostname: "apphost", pve: "pve-1", vmid: 101 },
            ]),
            exitCode: 0,
            command: tmplCommand.name,
            execute_on: tmplCommand.execute_on!,
            index: 0,
          } as any;
        }
        return {
          stderr: "",
          result: "",
          exitCode: 0,
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on!,
          index: 0,
        } as any;
      }
      protected runOnLxc() {
        this.lxcCalled = true;
        return {
          stderr: "",
          result: "",
          exitCode: 0,
          command: "",
          execute_on: "lxc",
          index: 1,
        } as any;
      }
    }
    const exec = new TestExec([command], [], dummyVE, defaults, "sh");
    const rc = await exec.run();
    expect(rc?.lastSuccessfull).toBeUndefined();
    expect((exec as any).lxcCalled).toBe(false);
  });

  it("fails when VMID differs between probe and VMContext", async () => {
    const storage = StorageContext.getInstance();
    storage.setVMContext({
      vmid: 999,
      vekey: "ve_localhost",
      data: { hostname: "apphost", pve: "pve-1" },
    } as any);
    const command: ICommand = {
      name: "deploy",
      command: "echo 'hello'",
      execute_on: "host:apphost",
    };
    class TestExec extends VeExecution {
      public lxcCalled = false;
      protected runOnVeHost(
        _input: string,
        tmplCommand: ICommand,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _timeoutMs = 10000,
        remoteCommand?: string[],
      ) {
        if (remoteCommand && remoteCommand.length > 0) {
          return {
            stderr: "",
            result: JSON.stringify([
              { hostname: "apphost", pve: "pve-1", vmid: 101 },
            ]),
            exitCode: 0,
            command: tmplCommand.name,
            execute_on: tmplCommand.execute_on!,
            index: 0,
          } as any;
        }
        return {
          stderr: "",
          result: "",
          exitCode: 0,
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on!,
          index: 0,
        } as any;
      }
      protected runOnLxc() {
        this.lxcCalled = true;
        return {
          stderr: "",
          result: "",
          exitCode: 0,
          command: "",
          execute_on: "lxc",
          index: 1,
        } as any;
      }
    }
    const exec = new TestExec([command], [], dummyVE, defaults, "sh");
    const rc = await exec.run();
    expect(rc?.lastSuccessfull).toBeUndefined();
    expect((exec as any).lxcCalled).toBe(false);
  });

  it("replaces host command variables using vmctx.data (not outputs)", async () => {
    const storage = StorageContext.getInstance();
    storage.setVMContext({
      vmid: 101,
      vekey: "ve_localhost",
      data: { hostname: "apphost", pve: "pve-1", app_name: "myapp" },
    } as any);
    const command: ICommand = {
      name: "deploy",
      command: "echo '{{app_name}}-on-{{hostname}}'",
      execute_on: "host:apphost",
    };
    class TestExec extends VeExecution {
      public captured: string | undefined;
      protected runOnVeHost(
        _input: string,
        tmplCommand: ICommand,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _timeoutMs = 10000,
        remoteCommand?: string[],
      ) {
        if (remoteCommand && remoteCommand.length > 0) {
          return {
            stderr: "",
            result: JSON.stringify([
              { hostname: "apphost", pve: "pve-1", vmid: 101 },
            ]),
            exitCode: 0,
            command: tmplCommand.name,
            execute_on: tmplCommand.execute_on!,
            index: 0,
          } as any;
        }
        return {
          stderr: "",
          result: "",
          exitCode: 0,
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on!,
          index: 0,
        } as any;
      }
      protected runOnLxc(
        _vmid: string | number,
        cmd: string,
        tmplCommand: ICommand,
      ) {
        this.captured = cmd;
        return {
          stderr: "",
          result: cmd,
          exitCode: 0,
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on!,
          index: 1,
        } as any;
      }
    }
    // Provide an input that would differ from vmctx.data to ensure data wins
    const exec = new TestExec(
      [command],
      [{ id: "app_name", value: "inputApp" }],
      dummyVE,
      defaults,
      "sh",
    );
    const rc = await exec.run();
    expect(rc?.lastSuccessfull).toBe(0);
    expect(exec.captured).toContain("myapp-on-apphost");
    expect(exec.captured).not.toContain("inputApp");
  });

  it("prefers vmctx.data.vm_id over outputs.vm_id", async () => {
    const storage = StorageContext.getInstance();
    storage.setVMContext({
      vmid: 101,
      vekey: "ve_localhost",
      data: { hostname: "apphost", pve: "pve-1", vm_id: 101 },
    } as any);

    const command: ICommand = {
      name: "deploy",
      command: "echo '{{vm_id}}'",
      execute_on: "host:apphost",
    };

    class TestExec extends VeExecution {
      public captured: string | undefined;
      protected runOnVeHost(
        _input: string,
        tmplCommand: ICommand,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _timeoutMs = 10000,
        remoteCommand?: string[],
      ) {
        if (remoteCommand && remoteCommand.length > 0) {
          return {
            stderr: "",
            result: JSON.stringify([
              { hostname: "apphost", pve: "pve-1", vmid: 101 },
            ]),
            exitCode: 0,
            command: tmplCommand.name,
            execute_on: tmplCommand.execute_on!,
            index: 0,
          } as any;
        }
        return {
          stderr: "",
          result: "",
          exitCode: 0,
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on!,
          index: 0,
        } as any;
      }
      protected runOnLxc(
        _vmid: string | number,
        cmd: string,
        tmplCommand: ICommand,
      ) {
        this.captured = cmd;
        return {
          stderr: "",
          result: cmd,
          exitCode: 0,
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on!,
          index: 1,
        } as any;
      }
    }

    const outputs = [{ id: "vm_id", value: "999" }] as any;
    const exec = new TestExec([command], outputs, dummyVE, defaults, "sh");
    const rc = await exec.run();
    expect(rc?.lastSuccessfull).toBe(0);
    expect(exec.captured).toContain("101");
    expect(exec.captured).not.toContain("999");
  });
});
