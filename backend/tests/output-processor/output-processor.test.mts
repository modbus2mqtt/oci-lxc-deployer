import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OutputProcessor } from "@src/output-processor.mjs";
import { ICommand } from "@src/types.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";

let env: TestEnvironment;

beforeAll(() => {
  env = createTestEnvironment(import.meta.url, {
    jsonIncludePatterns: [],
  });
  env.initPersistence({ enableCache: false });
});

afterAll(() => {
  env.cleanup();
});

describe("OutputProcessor", () => {
  it("should process multiple outputs from JSON array correctly", () => {
    const outputs = new Map<string, string | number | boolean>();
    const outputsRaw: { name: string; value: string | number | boolean }[] | undefined = undefined;
    const defaults = new Map<string, string | number | boolean>();
    // Use ExecutionMode.PRODUCTION to prevent processLocalFileValue from trying to read files locally
    // When executionMode is PRODUCTION, processLocalFileValue returns the value as-is (with "local:" prefix)
    const processor = new OutputProcessor(outputs, outputsRaw, defaults, ExecutionMode.PRODUCTION);

    // Simulate get-latest-os-template.sh output: array with template_path and ostype
    // This matches the exact format from get-latest-os-template.sh
    const stdout = '[{"id":"template_path","value":"local:vztmpl/alpine-3.22-default_20250617_amd64.tar.xz"},{"id":"ostype","value":"alpine"}]';
    const tmplCommand: ICommand = {
      name: "get-latest-os-template",
      execute_on: "ve",
    };

    processor.parseAndUpdateOutputs(stdout, tmplCommand);

    // Debug: Show what's actually in outputs
    const outputKeys = Array.from(outputs.keys());
    const outputSize = outputs.size;
    const outputEntries = Array.from(outputs.entries()).map(([k, v]) => `${k}=${v}`).join(", ");

    // Verify both outputs were added to the map
    // If this fails, the error message will show what's actually in outputs
    if (!outputs.has("template_path")) {
      expect.fail(`template_path not found in outputs. Available keys: ${outputKeys.join(", ")}, size: ${outputSize}, entries: ${outputEntries}`);
    }
    if (!outputs.has("ostype")) {
      expect.fail(`ostype not found in outputs. Available keys: ${outputKeys.join(", ")}, size: ${outputSize}, entries: ${outputEntries}`);
    }
    expect(outputs.get("template_path")).toBe("local:vztmpl/alpine-3.22-default_20250617_amd64.tar.xz");
    expect(outputs.get("ostype")).toBe("alpine");

    // Verify that both outputs are present
    expect(outputs.size).toBe(2);
  });

  it("should process multiple outputs from JSON array with uniqueMarker", () => {
    const outputs = new Map<string, string | number | boolean>();
    const outputsRaw: { name: string; value: string | number | boolean }[] | undefined = undefined;
    const defaults = new Map<string, string | number | boolean>();
    const processor = new OutputProcessor(outputs, outputsRaw, defaults, ExecutionMode.PRODUCTION);

    // Simulate output with uniqueMarker (as it would come from SSH)
    const uniqueMarker = "UNIQUE_MARKER_12345";
    const stdout = `Welcome to Ubuntu\nSome banner text\n${uniqueMarker}\n[{"id":"template_path","value":"local:vztmpl/alpine-3.22-default_20250617_amd64.tar.xz"},{"id":"ostype","value":"alpine"}]`;
    const tmplCommand: ICommand = {
      name: "get-latest-os-template",
      execute_on: "ve",
    };

    processor.parseAndUpdateOutputs(stdout, tmplCommand, uniqueMarker);

    // Verify both outputs were added to the map
    expect(outputs.has("template_path")).toBe(true);
    expect(outputs.has("ostype")).toBe(true);
    expect(outputs.get("template_path")).toBe("local:vztmpl/alpine-3.22-default_20250617_amd64.tar.xz");
    expect(outputs.get("ostype")).toBe("alpine");
    expect(outputs.size).toBe(2);
  });
});

