import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { VeExecutionCommandProcessor } from "@src/ve-execution/ve-execution-command-processor.mjs";
import { ICommand } from "@src/types.mjs";
import { VeExecutionMessageEmitter } from "@src/ve-execution/ve-execution-message-emitter.mjs";
import { VariableResolver } from "@src/variable-resolver.mjs";
import { EventEmitter } from "events";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

let env: TestEnvironment;
let persistenceHelper: TestPersistenceHelper;

/**
 * Helper function to create mock execution functions that should not be called.
 * These are used in tests that only test properties commands or other non-execution functionality.
 */
function createMockExecutionFunctions() {
  return {
    runOnLxc: async () => {
      throw new Error("runOnLxc should not be called");
    },
    runOnVeHost: async () => {
      throw new Error("runOnVeHost should not be called");
    },
    executeOnHost: async () => {
      throw new Error("executeOnHost should not be called");
    },
  };
}

describe("VeExecutionCommandProcessor", () => {
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
  it("should process properties command with variable replacement in values", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {
      username: "macbckpsrv",
      password: "secret123",
      share_name: "backup",
    };
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "set-parameters",
      properties: [
        { id: "ostype", value: "debian" },
        { id: "volumes", value: "data=timemachine" },
        { id: "envs", value: "USERNAME={{username}}\nPASSWORD={{password}}\nSHARE_NAME={{share_name}}" },
      ],
      execute_on: "ve",
    };

    processor.handlePropertiesCommand(cmd, 0);

    // Verify outputs were set correctly
    expect(outputs.get("ostype")).toBe("debian");
    expect(outputs.get("volumes")).toBe("data=timemachine");

    // Verify that variables in envs were replaced
    const envsValue = outputs.get("envs");
    expect(envsValue).toBeDefined();
    expect(typeof envsValue).toBe("string");

    const envsStr = envsValue as string;
    // Check that variables were replaced
    expect(envsStr).toContain("USERNAME=macbckpsrv");
    expect(envsStr).toContain("PASSWORD=secret123");
    expect(envsStr).toContain("SHARE_NAME=backup");

    // Verify that the original variable placeholders are not present
    expect(envsStr).not.toContain("{{username}}");
    expect(envsStr).not.toContain("{{password}}");
    expect(envsStr).not.toContain("{{share_name}}");
  });

  it("should handle properties with single object", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {
      var: "replaced",
    };
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "set-single-property",
      properties: { id: "test_id", value: "test_{{var}}_value" },
      execute_on: "ve",
    };

    processor.handlePropertiesCommand(cmd, 0);

    expect(outputs.get("test_id")).toBe("test_replaced_value");
  });

  it("should handle properties with array of objects", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {
      var: "test",
    };
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "set-multiple-properties",
      properties: [
        { id: "prop1", value: "value1" },
        { id: "prop2", value: "value2_{{var}}" },
      ],
      execute_on: "ve",
    };

    processor.handlePropertiesCommand(cmd, 0);

    expect(outputs.get("prop1")).toBe("value1");
    expect(outputs.get("prop2")).toBe("value2_test");
  });

  it("should handle properties with missing id gracefully", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "invalid-properties",
      properties: { value: "test" } as any, // Missing id
      execute_on: "ve",
    };

    processor.handlePropertiesCommand(cmd, 0);

    // Outputs should be empty since id was missing
    expect(outputs.size).toBe(0);
  });

  it("should handle skipped commands", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "test (skipped)",
      description: "Skipped: all required parameters missing",
      command: "echo test",
      execute_on: "ve",
    };

    const msgIndex = processor.handleSkippedCommand(cmd, 0);
    expect(msgIndex).toBe(1);
  });

  it("should load command content from script file", () => {
    persistenceHelper.writeTextSync(
      Volume.LocalRoot,
      "scripts/testscript.sh",
      "echo test script",
    );

    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const scriptContent = persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "scripts/testscript.sh",
    );
    const cmd: ICommand = {
      name: "test",
      script: "testscript.sh",
      scriptContent,
      execute_on: "ve",
    };

    const content = processor.loadCommandContent(cmd);
    expect(content).toBe("echo test script");
  });

  it("should load command content from command string", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "test",
      command: "echo test command",
      execute_on: "ve",
    };

      const content = processor.loadCommandContent(cmd);
      expect(content).toBeTruthy();
      if (!content) {
        throw new Error("Expected script content");
      }
    expect(content).toBe("echo test command");
  });

  it("should get vm_id from inputs or outputs", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    // Test with input
    inputs["vm_id"] = "101";
    expect(processor.getVmId()).toBe("101");

    // Test with output (should prefer input)
    outputs.set("vm_id", "102");
    expect(processor.getVmId()).toBe("101"); // Input takes precedence

    // Test with output only
    delete inputs["vm_id"];
    expect(processor.getVmId()).toBe("102");
  });

  describe("Library support (Option 3)", () => {
    it("should load script with library prepended", () => {
      // Create library with functions
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "scripts/test-library.sh",
        "test_function() { echo 'library function'; }",
      );
      // Create script that uses library function
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "scripts/test-script.sh",
        "test_function",
      );

      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      const mockExec = createMockExecutionFunctions();
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        ...mockExec,
        outputsRaw: undefined,
        setOutputsRaw: () => {},
      });

      const libraryContent = persistenceHelper.readTextSync(
        Volume.LocalRoot,
        "scripts/test-library.sh",
      );
      const scriptContent = persistenceHelper.readTextSync(
        Volume.LocalRoot,
        "scripts/test-script.sh",
      );
      const cmd: ICommand = {
        name: "test",
        script: "test-script.sh",
        scriptContent,
        libraryPath: "test-library.sh",
        libraryContent,
        execute_on: "ve",
      };

      const content = processor.loadCommandContent(cmd);
      expect(content).toBeTruthy();
      if (!content) {
        throw new Error("Expected script content");
      }
      expect(content).toContain("test_function() { echo 'library function'; }");
      expect(content).toContain("test_function");
      expect(content).toContain("# --- Script starts here ---");
      // Library should come before script
      const libraryIndex = content!.indexOf("test_function()");
      const scriptIndex = content!.indexOf("test_function", libraryIndex + 1);
      expect(libraryIndex).toBeLessThan(scriptIndex);
    });

    it("should throw error when library file not found", () => {
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "scripts/test-script.sh",
        "echo test",
      );

      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      const mockExec = createMockExecutionFunctions();
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        ...mockExec,
        outputsRaw: undefined,
        setOutputsRaw: () => {},
      });

      const scriptContent = persistenceHelper.readTextSync(
        Volume.LocalRoot,
        "scripts/test-script.sh",
      );
      const cmd: ICommand = {
        name: "test",
        script: "test-script.sh",
        scriptContent,
        libraryPath: "non-existent-library.sh",
        execute_on: "ve",
      };

      expect(() => processor.loadCommandContent(cmd)).toThrow(/Library content missing/);
    });

    it("should work without library when libraryPath is not specified", () => {
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "scripts/test-script.sh",
        "echo test script",
      );

      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      const mockExec = createMockExecutionFunctions();
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        ...mockExec,
        outputsRaw: undefined,
        setOutputsRaw: () => {},
      });

      const scriptContent = persistenceHelper.readTextSync(
        Volume.LocalRoot,
        "scripts/test-script.sh",
      );
      const cmd: ICommand = {
        name: "test",
        script: "test-script.sh",
        scriptContent,
        execute_on: "ve",
      };

      const content = processor.loadCommandContent(cmd);
      expect(content).toBe("echo test script");
      expect(content).not.toContain("# --- Script starts here ---");
    });

    it("should prepend library content before script that calls library function", () => {
      // Create library with function
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "scripts/test-library.sh",
        "my_library_function() { echo 'from library'; }",
      );
      // Create script that calls library function
      persistenceHelper.writeTextSync(
        Volume.LocalRoot,
        "scripts/test-script.sh",
        "my_library_function",
      );

      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      const mockExec = createMockExecutionFunctions();
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        ...mockExec,
        outputsRaw: undefined,
        setOutputsRaw: () => {},
      });

      const libraryContent = persistenceHelper.readTextSync(
        Volume.LocalRoot,
        "scripts/test-library.sh",
      );
      const scriptContent = persistenceHelper.readTextSync(
        Volume.LocalRoot,
        "scripts/test-script.sh",
      );
      const cmd: ICommand = {
        name: "test",
        script: "test-script.sh",
        scriptContent,
        libraryPath: "test-library.sh",
        libraryContent,
        execute_on: "ve",
      };

      const content = processor.loadCommandContent(cmd);
      expect(content).toBeTruthy();
      if (!content) {
        throw new Error("Expected script content");
      }
      // Library should be prepended
      expect(content).toContain("my_library_function() { echo 'from library'; }");
      // Script should be after library
      expect(content).toContain("my_library_function");
      expect(content).toContain("# --- Script starts here ---");
      // Library should come before script marker
      const libraryIndex = content.indexOf("my_library_function()");
      const markerIndex = content.indexOf("# --- Script starts here ---");
      const scriptCallIndex = content.indexOf("my_library_function", libraryIndex + 1);
      expect(libraryIndex).toBeLessThan(markerIndex);
      expect(markerIndex).toBeLessThan(scriptCallIndex);
    });
  });

  describe("execute_on: application:<app-id>", () => {
    /**
     * Test scenarios for execute_on: "application:<app-id>"
     *
     * The application: prefix allows executing commands on a running container
     * that has a specific application_id in its notes/config.
     *
     * - 0 running containers with matching app-id → Error
     * - 1 running container with matching app-id → Execute on that container
     * - 2+ running containers with matching app-id → Error (ambiguous)
     */

    it("should throw error when no container matches the application_id", async () => {
      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      let runOnLxcCalled = false;
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        runOnLxc: async () => {
          runOnLxcCalled = true;
          return { command: "test", execute_on: "lxc", exitCode: 0, result: "", stderr: "" };
        },
        runOnVeHost: async () => {
          throw new Error("runOnVeHost should not be called");
        },
        executeOnHost: async () => {
          throw new Error("executeOnHost should not be called");
        },
        outputsRaw: undefined,
        setOutputsRaw: () => {},
        // Mock: No running containers match the application_id
        resolveApplicationToVmId: async () => {
          throw new Error("No running container found with application_id 'my-app'. Expected exactly 1 running container, found 0.");
        },
      });

      const cmd: ICommand = {
        name: "test-app-command",
        command: "echo 'test'",
        execute_on: "application:my-app",
      };

      await expect(processor.executeCommandByTarget(cmd, "echo 'test'")).rejects.toThrow(
        /No running container found with application_id 'my-app'/
      );
      expect(runOnLxcCalled).toBe(false);
    });

    it("should execute command on the container when exactly one matches the application_id", async () => {
      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      let runOnLxcVmId: string | number | undefined;
      let runOnLxcCommand: string | undefined;
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        runOnLxc: async (vm_id, command) => {
          runOnLxcVmId = vm_id;
          runOnLxcCommand = command;
          return { command: "test", execute_on: "lxc", exitCode: 0, result: "", stderr: "" };
        },
        runOnVeHost: async () => {
          throw new Error("runOnVeHost should not be called");
        },
        executeOnHost: async () => {
          throw new Error("executeOnHost should not be called");
        },
        outputsRaw: undefined,
        setOutputsRaw: () => {},
        // Mock: Exactly one running container matches the application_id
        resolveApplicationToVmId: async (appId) => {
          if (appId === "postgres-db") {
            return 105; // vm_id of the matching running container
          }
          throw new Error(`No running container found with application_id '${appId}'`);
        },
      });

      const cmd: ICommand = {
        name: "run-on-postgres",
        command: "psql -c 'SELECT 1'",
        execute_on: "application:postgres-db",
      };

      await processor.executeCommandByTarget(cmd, "psql -c 'SELECT 1'");

      expect(runOnLxcVmId).toBe(105);
      expect(runOnLxcCommand).toBe("psql -c 'SELECT 1'");
    });

    it("should throw error when multiple containers match the application_id", async () => {
      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      let runOnLxcCalled = false;
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        runOnLxc: async () => {
          runOnLxcCalled = true;
          return { command: "test", execute_on: "lxc", exitCode: 0, result: "", stderr: "" };
        },
        runOnVeHost: async () => {
          throw new Error("runOnVeHost should not be called");
        },
        executeOnHost: async () => {
          throw new Error("executeOnHost should not be called");
        },
        outputsRaw: undefined,
        setOutputsRaw: () => {},
        // Mock: Multiple running containers match the application_id
        resolveApplicationToVmId: async () => {
          throw new Error("Multiple running containers found with application_id 'duplicated-app'. Expected exactly 1 running container, found 2 (vm_ids: 101, 102).");
        },
      });

      const cmd: ICommand = {
        name: "test-duplicated-app",
        command: "echo 'test'",
        execute_on: "application:duplicated-app",
      };

      await expect(processor.executeCommandByTarget(cmd, "echo 'test'")).rejects.toThrow(
        /Multiple running containers found with application_id 'duplicated-app'/
      );
      expect(runOnLxcCalled).toBe(false);
    });

    it("should replace variables in command before execution on application container", async () => {
      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {
        db_name: "production",
      };
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      let capturedCommand: string | undefined;
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        runOnLxc: async (vm_id, command) => {
          capturedCommand = command;
          return { command: "test", execute_on: "lxc", exitCode: 0, result: "", stderr: "" };
        },
        runOnVeHost: async () => {
          throw new Error("runOnVeHost should not be called");
        },
        executeOnHost: async () => {
          throw new Error("executeOnHost should not be called");
        },
        outputsRaw: undefined,
        setOutputsRaw: () => {},
        resolveApplicationToVmId: async () => 200,
      });

      const cmd: ICommand = {
        name: "backup-db",
        command: "pg_dump {{ db_name }}",
        execute_on: "application:postgres",
      };

      await processor.executeCommandByTarget(cmd, "pg_dump {{ db_name }}");

      expect(capturedCommand).toBe("pg_dump production");
    });
  });
});

