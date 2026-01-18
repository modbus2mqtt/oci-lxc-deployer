import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { ContextManager } from "@src/context-manager.mjs";
import { ApiUri } from "@src/types.mjs";
import { ProxmoxTestHelper } from "@tests/ve-test-helper.mjs";
import { registerApplicationRoutes } from "@src/webapp/webapp-application-routes.mjs";

describe("Application routes", () => {
  let app: express.Application;
  let helper: ProxmoxTestHelper;
  let storageContext: ContextManager;
  let veContextKey: string;

  beforeEach(async () => {
    helper = new ProxmoxTestHelper();
    await helper.setup();

    const storageContextPath = path.join(helper.localDir, "storagecontext.json");
    const secretFilePath = path.join(helper.localDir, "secret.txt");
    fs.writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }

    PersistenceManager.initialize(
      helper.localDir,
      storageContextPath,
      secretFilePath,
    );
    const pm = PersistenceManager.getInstance();
    (pm as any).pathes = {
      localPath: helper.localDir,
      jsonPath: helper.jsonDir,
      schemaPath: helper.schemaDir,
    };

    const persistence = (pm as any).persistence;
    if (persistence) {
      (persistence as any).pathes = {
        localPath: helper.localDir,
        jsonPath: helper.jsonDir,
        schemaPath: helper.schemaDir,
      };
      if ((persistence as any).applicationHandler) {
        ((persistence as any).applicationHandler as any).pathes = {
          localPath: helper.localDir,
          jsonPath: helper.jsonDir,
          schemaPath: helper.schemaDir,
        };
      }
      if ((persistence as any).templateHandler) {
        ((persistence as any).templateHandler as any).pathes = {
          localPath: helper.localDir,
          jsonPath: helper.jsonDir,
          schemaPath: helper.schemaDir,
        };
      }
    }

    storageContext = pm.getContextManager();
    (storageContext as any).pathes = {
      localPath: helper.localDir,
      jsonPath: helper.jsonDir,
      schemaPath: helper.schemaDir,
    };

    veContextKey = storageContext.setVEContext({
      host: "testhost",
      port: 22,
      current: true,
    });

    app = express();
    registerApplicationRoutes(app, storageContext, (res, payload, status = 200) => {
      res.status(status).json(payload);
    });
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  it("returns unresolved parameters using installation task", async () => {
    const appDir = path.join(helper.jsonDir, "applications", "testapp");
    fs.mkdirSync(appDir, { recursive: true });
    const templatesDir = path.join(appDir, "templates");
    fs.mkdirSync(templatesDir, { recursive: true });

    helper.writeApplication("testapp", {
      name: "Test App",
      description: "Test application",
      installation: ["set-parameters.json"],
    });

    helper.writeTemplate("testapp", "set-parameters.json", {
      execute_on: "ve",
      name: "Set Parameters",
      description: "Set parameters",
      parameters: [
        {
          id: "hostname",
          name: "Hostname",
          type: "string",
          required: true,
          description: "Hostname for the container",
        },
      ],
      commands: [
        {
          name: "Test Command",
          command: "echo 'ok'",
        },
      ],
    });

    const url = ApiUri.UnresolvedParameters
      .replace(":application", "testapp")
      .replace(":task", "random-task")
      .replace(":veContext", veContextKey);

    const response = await request(app).get(url).expect(200);

    expect(response.body.unresolvedParameters).toBeDefined();
    expect(response.body.unresolvedParameters.length).toBeGreaterThan(0);
    expect(response.body.unresolvedParameters[0].id).toBe("hostname");
  });
});
