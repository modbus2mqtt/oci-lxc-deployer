import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OutputProcessor } from "@src/output-processor.mjs";
import { ICommand } from "@src/types.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";

describe("OutputProcessor - Validate Expected Outputs", () => {
  let env: TestEnvironment;
  let outputProcessor: OutputProcessor;
  let outputs: Map<string, string | number | boolean>;
  let defaults: Map<string, string | number | boolean>;

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    env.initPersistence({ enableCache: false });
  });

  afterAll(() => {
    env.cleanup();
  });

  beforeEach(() => {
    outputs = new Map();
    defaults = new Map();
    outputProcessor = new OutputProcessor(outputs, undefined, defaults, ExecutionMode.TEST);
  });

  it("should not throw when all expected outputs are present", () => {
    const command: ICommand = {
      name: "Test Command",
      script: "test.sh",
      outputs: ["output1", "output2"],
    };

    const stdout = '[{"id":"output1","value":"value1"},{"id":"output2","value":"value2"}]';

    expect(() => {
      outputProcessor.parseAndUpdateOutputs(stdout, command);
    }).not.toThrow();

    expect(outputs.get("output1")).toBe("value1");
    expect(outputs.get("output2")).toBe("value2");
  });

  it("should throw when some expected outputs are missing", () => {
    const command: ICommand = {
      name: "Test Command",
      script: "test.sh",
      outputs: ["output1", "output2", "output3"],
    };

    const stdout = '[{"id":"output1","value":"value1"},{"id":"output2","value":"value2"}]';

    expect(() => {
      outputProcessor.parseAndUpdateOutputs(stdout, command);
    }).toThrow(/missing expected outputs.*output3/);

    expect(outputs.get("output1")).toBe("value1");
    expect(outputs.get("output2")).toBe("value2");
    expect(outputs.has("output3")).toBe(false);
  });

  it("should throw when all expected outputs are missing", () => {
    const command: ICommand = {
      name: "Test Command",
      script: "test.sh",
      outputs: ["output1", "output2"],
    };

    const stdout = '[{"id":"other_output","value":"value"}]';

    expect(() => {
      outputProcessor.parseAndUpdateOutputs(stdout, command);
    }).toThrow(/missing expected outputs.*output1.*output2/);
  });

  it("should not throw when no outputs are expected", () => {
    const command: ICommand = {
      name: "Test Command",
      script: "test.sh",
    };

    const stdout = '[{"id":"output1","value":"value1"}]';

    expect(() => {
      outputProcessor.parseAndUpdateOutputs(stdout, command);
    }).not.toThrow();
  });

  it("should not throw when outputs with default values are missing", () => {
    const command: ICommand = {
      name: "Test Command",
      script: "test.sh",
      outputs: [
        "output1",
        { id: "output2", default: true },
      ],
    };

    const stdout = '[{"id":"output1","value":"value1"}]';

    expect(() => {
      outputProcessor.parseAndUpdateOutputs(stdout, command);
    }).not.toThrow();

    expect(outputs.get("output1")).toBe("value1");
  });

  it("should handle name/value format outputs correctly (enumValues special case)", () => {
    const command: ICommand = {
      name: "Test Command",
      script: "test.sh",
      outputs: ["enumValues"],
    };

    const stdout = '[{"name":"option1","value":"value1"},{"name":"option2","value":"value2"}]';

    expect(() => {
      outputProcessor.parseAndUpdateOutputs(stdout, command);
    }).not.toThrow();

    // In name/value format with "enumValues" as expected output, validation passes if any outputs are present
    // This is a special case for enum value lists
  });

  it("should handle single output object format", () => {
    const command: ICommand = {
      name: "Test Command",
      script: "test.sh",
      outputs: ["output1"],
    };

    const stdout = '{"id":"output1","value":"value1"}';

    expect(() => {
      outputProcessor.parseAndUpdateOutputs(stdout, command);
    }).not.toThrow();

    expect(outputs.get("output1")).toBe("value1");
  });

  it("should provide detailed error message with expected and received outputs", () => {
    const command: ICommand = {
      name: "Test Command",
      script: "test.sh",
      outputs: ["output1", "output2", "output3"],
    };

    const stdout = '[{"id":"output1","value":"value1"}]';

    try {
      outputProcessor.parseAndUpdateOutputs(stdout, command);
      expect.fail("Should have thrown an error");
    } catch (error: any) {
      expect(error.message).toContain("missing expected outputs");
      expect(error.message).toContain("output2");
      expect(error.message).toContain("output3");
      expect(error.message).toContain("Expected:");
      expect(error.message).toContain("Received:");
    }
  });
});

