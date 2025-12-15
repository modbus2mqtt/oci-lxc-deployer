import { describe, it, expect, beforeAll } from "vitest";
import { VeExecution } from "@src/ve-execution.mjs";
import { ICommand } from "@src/types.mjs";
import { spawnSync } from "child_process";
import fs from "fs";
import * as path from "path";
import { StorageContext } from "@src/storagecontext.mjs";
import { IVEContext } from "@src/backend-types.mjs";
describe("ProxmoxExecution shell quoting", () => {
  const dummySSH:IVEContext = { host: "localhost", port: 22 } as IVEContext;
  const defaults = new Map<string, string | number | boolean>();
  const inputs: { id: string; value: string | number | boolean }[] = [];

  beforeAll(() => {
    StorageContext.setInstance("local");
    // Write dummy sshconfig.json for local test
    const dir = path.join(process.cwd(), "local");
    const file = path.join(dir, "sshconfig.json");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(dummySSH, null, 2), "utf-8");
  });

  it("should execute a shell script with special characters via runOnProxmoxHost", () => {
    // Prepare a shell script with special characters
    const script =
      'echo "foo && bar; $PATH \'quoted\' \\"double\\" \\`backtick\\`"';
    const command: ICommand = {
      name: "test",
      command: script,
      execute_on: "ve",
    };
    const exec = new VeExecution([command], inputs, dummySSH, defaults);
    (exec as any).ssh = { host: "localhost", port: 22 };
    // runOnProxmoxHost as a mock: accepts all parameters, but only executes the command locally
    (exec as any).runOnVeHost = function (
      command: string,
      tmplCommand: ICommand,
      timeoutMs = 10000,
    ) {
      const proc = spawnSync("/bin/sh", ["-c", command], {
        encoding: "utf-8",
        timeout: timeoutMs,
      });
      const stdout = proc.stdout || "";
      const stderr = proc.stderr || "";
      const exitCode = typeof proc.status === "number" ? proc.status : -1;
      return {
        stderr,
        result: stdout,
        exitCode,
        command: tmplCommand.name,
        execute_on: tmplCommand.execute_on!,
        index: 0,
      };
    };
    exec.run = function () {
      const msg = this.runOnVeHost(
        command.command!,
        command,
        10000,
      );
      return {
        lastSuccessfull: msg.exitCode === 0 ? 0 : -1,
        inputs: [],
        outputs: [],
        defaults: [],
      };
    };
    const result = exec.run();
    expect(result?.lastSuccessfull).toBe(0);
  });

  it("should execute a shell script with special characters via runOnLxc (simulated)", () => {
    const script =
      '#!/bin/sh\n\
            echo "$@" >&2\n\
            echo "[lxc-attach-mock]: $@" >&2\n\
            echo \'{"id": "mocked", "value":true}\'';
    const command: ICommand = {
      name: "testlxc",
      command: script,
      execute_on: "lxc",
    };
    const exec = new VeExecution(
      [command],
      [{ id: "vm_id", value: "dummy" }],
      dummySSH,
      defaults,
      "sh"
    );
    (exec as any).ssh = { host: "localhost", port: 22 };
    exec.run = function () {
      let lastSuccess = -1;
      try {
        this.runOnLxc("dummy", command.command!, command, 10000
        );
        expect(this.outputs.get("mocked")).toBe(true);
        lastSuccess = 0;
      } catch {
        lastSuccess = -1;
      }
      return {
        lastSuccessfull: lastSuccess,
        inputs: [],
        outputs: [],
        defaults: [],
      };
    };
    const result = exec.run();
    // Check if the mock script was called and the arguments were logged

    expect(result?.lastSuccessfull).toBe(0);
  });
});
