import {
  ApplicationLoader,
  IReadApplicationOptions,
} from "@src/proxmoxapploader.mjs";
import fs from "fs";
import path from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const tmpDir = path.join(__dirname, "__apptest__");
const localPath = path.join(tmpDir, "local");
const jsonPath = path.join(tmpDir, "json");
const schemaPath = path.join(__dirname, "../schemas");

function writeJson(filePath: string, data: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

describe("ApplicationLoader.readApplicationJson", () => {
  let loader: ApplicationLoader;

  beforeEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    loader = new ApplicationLoader({ schemaPath, jsonPath, localPath });
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1. Application in localPath, extends application in jsonPath, unterschiedliche Namen", () => {
    writeJson(
      path.join(jsonPath, "applications", "baseapp", "application.json"),
      {
        name: "baseapp",
        installation: ["base-template.json"],
      },
    );
    writeJson(
      path.join(localPath, "applications", "myapp", "application.json"),
      {
        name: "myapp",
        extends: "baseapp",
        installation: ["my-template.json"],
      },
    );
    const opts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: { details: [] },
      taskTemplates: [],
    } as any;
    loader.readApplicationJson("myapp", opts);
    const templates = opts.taskTemplates.find(
      (t) => t.task === "installation",
    )?.templates;
    expect(templates).toContain("base-template.json");
    expect(templates).toContain("my-template.json");
  });

  it("2. Wie 1. Gleiche Namen", () => {
    writeJson(
      path.join(jsonPath, "applications", "myapp", "application.json"),
      {
        name: "myapp",
        installation: ["base-template.json"],
      },
    );
    writeJson(
      path.join(localPath, "applications", "myapp", "application.json"),
      {
        name: "myapp",
        extends: "json:myapp",
        installation: ["my-template.json"],
      },
    );
    const opts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: { details: [] },
      taskTemplates: [],
    } as any;
    loader.readApplicationJson("myapp", opts);
    const templates = opts.taskTemplates.find(
      (t) => t.task === "installation",
    )?.templates;
    expect(templates).toContain("base-template.json");
    expect(templates).toContain("my-template.json");
  });

  it("3. localPath application hat eine Template mit {before: extends application template}", () => {
    writeJson(
      path.join(jsonPath, "applications", "baseapp", "application.json"),
      {
        name: "baseapp",
        installation: ["base-template.json"],
      },
    );
    writeJson(
      path.join(localPath, "applications", "myapp", "application.json"),
      {
        name: "myapp",
        extends: "baseapp",
        installation: [
          { name: "my-template.json", before: "base-template.json" },
        ],
      },
    );
    const opts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: { details: [] },
      taskTemplates: [],
    } as any;
    loader.readApplicationJson("myapp", opts);
    const templates = opts.taskTemplates.find(
      (t) => t.task === "installation",
    )?.templates;
    expect(templates).toBeDefined();
    expect(templates![0]).toBe("my-template.json");
    expect(templates![1]).toBe("base-template.json");
  });

  it("4. extends application hat 2 Templates, localPath application mit after", () => {
    writeJson(
      path.join(jsonPath, "applications", "baseapp", "application.json"),
      {
        name: "baseapp",
        installation: ["base1.json", "base2.json"],
      },
    );
    writeJson(
      path.join(localPath, "applications", "myapp", "application.json"),
      {
        name: "myapp",
        extends: "baseapp",
        installation: [{ name: "my-template.json", after: "base1.json" }],
      },
    );
    const opts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: { details: [] },
      taskTemplates: [],
    } as any;
    loader.readApplicationJson("myapp", opts);
    const templates = opts.taskTemplates.find(
      (t) => t.task === "installation",
    )?.templates;
    expect(templates).toBeDefined();
    expect(templates![0]).toBe("base1.json");
    expect(templates![1]).toBe("my-template.json");
    expect(templates![2]).toBe("base2.json");
  });
  it("5. recursion application extends itself", () => {
    writeJson(
      path.join(jsonPath, "applications", "myapp", "application.json"),
      {
        name: "myapp",
        installation: ["base-template.json"],
      },
    );
    writeJson(
      path.join(localPath, "applications", "myapp", "application.json"),
      {
        name: "myapp",
        extends: "myapp",
        installation: ["my-template.json"],
      },
    );
    const opts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: { details: [] },
      taskTemplates: [],
    } as any;
    loader.readApplicationJson("myapp", opts);
    expect(() => loader.readApplicationJson("myapp", opts)).toThrow();
  });
});
