import { describe, it, expect } from "vitest";
import path from "path";
import { StorageContext } from "@src/storagecontext.mjs";
// TaskType is a string union; use literal values

describe("TemplateProcessor enum handling", () => {
  const backendRoot = path.join(__dirname, "..");
  const jsonPath = path.join(backendRoot, "json");
  const schemaPath = path.join(backendRoot, "schemas");
  const localPath = path.join(backendRoot, "local");

  // Ensure global StorageContext instance is set for TemplateProcessor defaults
  StorageContext.setInstance(localPath);
  const storage = new StorageContext(localPath, jsonPath, schemaPath);
  const tp = storage.getTemplateProcessor();
  const veContext = { host: "localhost", port: 22 } as any;

  it("keeps static enum values unchanged", async () => {
    const loaded = await tp.loadApplication(
      "test-enum",
      "installation",
      veContext,
      "sh",
    );
    const staticParam = loaded.parameters.find((p) => p.id === "color");
    expect(staticParam).toBeDefined();
    expect((staticParam as any).enumValues).toEqual(["red", "green", "blue"]);
  });

  it("exposes dynamic enum template reference for UI", async () => {
    const loaded = await tp.loadApplication(
      "test-enum",
      "installation",
      veContext,
      "sh",
    );
    const dynParam = loaded.parameters.find((p) => p.id === "iface");
    expect(dynParam).toBeDefined();
    // TemplateProcessor should surface the enumValuesTemplate to webuiTemplates
    expect(loaded.webuiTemplates).toContain("list-enum-values.json");
    // And should inject enumValues from the template output (value fields)
    expect((dynParam as any).enumValues).toEqual(["eth0", "eth1"]);
  });
});
