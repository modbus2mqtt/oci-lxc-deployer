import { describe, it, expect } from "vitest";
import { VariableResolver } from "@src/variable-resolver.mjs";

describe("VariableResolver", () => {
  it("should resolve variables from outputs, inputs, and defaults in all combinations", () => {
    type Combo = {
      output?: string | number | boolean;
      input?: string | number | boolean;
      def?: string | number | boolean;
      expected?: string | number | boolean;
    };
    // Priority: output > input > default > NOT_DEFINED
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
      // None (should return NOT_DEFINED)
      { expected: "NOT_DEFINED" },
    ];

    for (const combo of combos) {
      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();

      if (combo.output !== undefined) outputs.set("foo", combo.output);
      if (combo.input !== undefined) inputs["foo"] = combo.input;
      if (combo.def !== undefined) defaults.set("foo", combo.def);

      const resolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );

      const result = resolver.replaceVars("Value: {{ foo }}");
      expect(result).toBe("Value: " + combo.expected);
    }
  });

  it("should resolve variables with context", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();

    outputs.set("outputVar", "outputValue");
    inputs["inputVar"] = "inputValue";
    defaults.set("defaultVar", "defaultValue");

    const resolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );

    // Context should take precedence
    const ctx = { outputVar: "contextValue", newVar: "newValue" };
    const result = resolver.replaceVarsWithContext(
      "{{ outputVar }} and {{ newVar }}",
      ctx,
    );
    expect(result).toBe("contextValue and newValue");

    // Without context, should use outputs/inputs/defaults
    const result2 = resolver.replaceVarsWithContext(
      "{{ outputVar }} and {{ inputVar }}",
      {},
    );
    expect(result2).toBe("outputValue and inputValue");
  });

  it("should resolve list variables", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();

    outputs.set("list.volumes.volume1", "/var/libs/myapp/data");
    outputs.set("list.volumes.volume2", "/var/libs/myapp/log");
    outputs.set("list.envs.ENV1", "value1");
    outputs.set("list.envs.ENV2", "value2");

    const resolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );

    const result = resolver.replaceVars("{{ volumes }}");
    expect(result).toContain("volume1=/var/libs/myapp/data");
    expect(result).toContain("volume2=/var/libs/myapp/log");
    expect(result.split("\n").length).toBe(2);

    const result2 = resolver.replaceVars("{{ envs }}");
    expect(result2).toContain("ENV1=value1");
    expect(result2).toContain("ENV2=value2");
    expect(result2.split("\n").length).toBe(2);
  });

  it("should return NOT_DEFINED for undefined variables", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();

    const resolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );

    const result = resolver.replaceVars("Value: {{ undefinedVar }}");
    expect(result).toBe("Value: NOT_DEFINED");
  });
});
