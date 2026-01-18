import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProxmoxTestHelper } from "@tests/ve-test-helper.mjs";

describe("TemplateProcessor trace output", () => {
  const appName = "trace-app";
  let helper: ProxmoxTestHelper;

  beforeAll(async () => {
    helper = new ProxmoxTestHelper();
    await helper.setup();

    const appDir = path.join(helper.localDir, "applications", appName);
    const templatesDir = path.join(appDir, "templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    fs.writeFileSync(
      path.join(appDir, "application.json"),
      JSON.stringify(
        {
          name: "Trace App",
          installation: ["set-params.json", "needs-params.json"],
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      path.join(templatesDir, "set-params.json"),
      JSON.stringify(
        {
          execute_on: "ve",
          name: "Set Params",
          description: "Sets properties",
          commands: [
            {
              name: "set-properties",
              properties: [
                { id: "oci_image", value: "ghcr.io/example/app" },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      path.join(templatesDir, "needs-params.json"),
      JSON.stringify(
        {
          execute_on: "ve",
          name: "Needs Params",
          description: "Requires parameters",
          parameters: [
            {
              id: "oci_image",
              name: "OCI Image",
              type: "string",
              required: true,
              description: "Image reference",
            },
            {
              id: "missing_required",
              name: "Missing Required",
              type: "string",
              required: true,
              description: "Missing by design",
            },
          ],
          commands: [
            { name: "echo", command: "echo ok" },
          ],
        },
        null,
        2,
      ),
    );
  });

  afterAll(async () => {
    await helper.cleanup();
  });

  it("should provide template and parameter trace", async () => {
    const processor = helper.createTemplateProcessor();
    const result = await processor.loadApplication(appName, "installation", {
      host: "localhost",
      port: 22,
    } as any);

    expect(result.templateTrace).toBeDefined();
    expect(result.parameterTrace).toBeDefined();
    expect(result.traceInfo).toBeDefined();
    expect(result.traceInfo?.task).toBe("installation");

    const ociImage = result.parameterTrace!.find((p) => p.id === "oci_image");
    const missingRequired = result.parameterTrace!.find((p) => p.id === "missing_required");

    expect(ociImage?.source).toBe("template_properties");
    expect(ociImage?.sourceTemplate).toBe("set-params.json");
    expect(missingRequired?.source).toBe("missing");
  });
});