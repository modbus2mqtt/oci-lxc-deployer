import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
// TaskType is a string union; use literal values

describe("TemplateProcessor enum handling", () => {
  let env: TestEnvironment;
  let contextManager: ReturnType<ReturnType<typeof PersistenceManager.getInstance>["getContextManager"]>;
  let tp: any;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [
        "^applications/test-enum/.*",
        "^shared/templates/list-enum-values.json$",
      ],
    });
    const { ctx } = env.initPersistence();
    contextManager = ctx;
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    env?.cleanup();
  });

  it("keeps static enum values unchanged", async () => {
    const loaded = await tp.loadApplication(
      "test-enum",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );
    const staticParam = loaded.parameters.find(
      (p: { id: string }) => p.id === "color",
    );
    expect(staticParam).toBeDefined();
    // Validate correct enumeration regardless of underlying implementation
    expect(Array.isArray(staticParam?.enumValues)).toBe(true);
    expect(staticParam?.enumValues).toContain("red");
    expect(staticParam?.enumValues).toContain("green");
    expect(staticParam?.enumValues).toContain("blue");
  });

  it("exposes dynamic enum template reference for UI", async () => {
    const loaded = await tp.loadApplication(
      "test-enum",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );
    const dynParam = loaded.parameters.find(
      (p: { id: string }) => p.id === "iface",
    );
    expect(dynParam).toBeDefined();
    // TemplateProcessor should surface the enumValuesTemplate to webuiTemplates
    expect(loaded.webuiTemplates).toContain("list-enum-values.json");
    // And should inject enumValues from the template output
    // The template returns [{name: "eth0", value: "eth0"}, {name: "eth1", value: "eth1"}]
    // TemplateProcessor assigns rc.outputs directly to enumValues
    const enumValues = (dynParam as any).enumValues;
    expect(Array.isArray(enumValues)).toBe(true);
    expect(enumValues.length).toBe(2);
    // Check that it contains the expected objects
    expect(enumValues).toContainEqual({ name: "eth0", value: "eth0" });
    expect(enumValues).toContainEqual({ name: "eth1", value: "eth1" });
  });
});
