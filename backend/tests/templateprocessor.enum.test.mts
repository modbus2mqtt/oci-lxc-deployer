import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { StorageContext } from "@src/storagecontext.mjs";
// TaskType is a string union; use literal values

describe("TemplateProcessor enum handling", () => {
  let testDir: string;
  let secretFilePath: string;
  let storage: StorageContext;
  let tp: any;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    // Create a temporary directory for the test
    testDir = mkdtempSync(path.join(tmpdir(), "templateprocessor-enum-test-"));
    secretFilePath = path.join(testDir, "secret.txt");
    
    // Create a valid storagecontext.json file
    const storageContextPath = path.join(testDir, "storagecontext.json");
    writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

    // Ensure global StorageContext instance is set for TemplateProcessor defaults
    StorageContext.setInstance(testDir, secretFilePath);
    storage = StorageContext.getInstance();
    tp = storage.getTemplateProcessor();
  });

  afterAll(() => {
    // Cleanup test directory
    try {
      if (testDir && require("fs").existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it("keeps static enum values unchanged", async () => {
    const loaded = await tp.loadApplication(
      "test-enum",
      "installation",
      veContext,
      "sh",
    );
    const staticParam = loaded.parameters.find((p: { id: string }) => p.id === "color");
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
      "sh",
    );
    const dynParam = loaded.parameters.find((p: { id: string }) => p.id === "iface");
    expect(dynParam).toBeDefined();
    // TemplateProcessor should surface the enumValuesTemplate to webuiTemplates
    expect(loaded.webuiTemplates).toContain("list-enum-values.json");
    // And should inject enumValues from the template output (value fields)
    expect((dynParam as any).enumValues).toEqual(["eth0", "eth1"]);
  });
});
