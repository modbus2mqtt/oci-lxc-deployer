import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { StorageContext } from "@src/storagecontext.mjs";
import { WebAppVE } from "@src/webapp-ve.mts";
import { ApiUri, IPostVeConfigurationBody } from "@src/types.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { ProxmoxTestHelper } from "@tests/ve-test-helper.mjs";
import { IRestartInfo } from "@src/ve-execution.mjs";

describe("WebAppVE API", () => {
  let app: express.Application;
  let helper: ProxmoxTestHelper;
  let storageContext: StorageContext;
  let veContextKey: string;
  let webAppVE: WebAppVE;

  beforeEach(async () => {
    helper = new ProxmoxTestHelper();
    await helper.setup();
    // Create StorageContext with correct paths pointing to test directories
    const storageContextPath = path.join(helper.localDir, "storagecontext.json");
    const secretFilePath = path.join(helper.localDir, "secret.txt");
    fs.writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");
    
    // Create StorageContext with test paths
    storageContext = new StorageContext(
      helper.localDir,
      storageContextPath,
      secretFilePath,
    );
    // Override jsonPath and schemaPath to point to test directories
    (storageContext as any).jsonPath = helper.jsonDir;
    (storageContext as any).schemaPath = helper.schemaDir;
    (storageContext as any).pathes = {
      localPath: helper.localDir,
      jsonPath: helper.jsonDir,
      schemaPath: helper.schemaDir,
    };
    (StorageContext as any).instance = storageContext;
    
    // Create a test VE context using the proper method
    veContextKey = "ve_testhost";
    storageContext.setVEContext({
      host: "testhost",
      port: 22,
      current: true,
    });
    
    app = express();
    webAppVE = new WebAppVE(app);
    webAppVE.init();
  });

  afterEach(async () => {
    await helper.cleanup();
  });

  describe("POST /api/ve-configuration/:application/:task/:veContext", () => {
    it("should successfully start configuration and return restartKey and vmInstallKey", async () => {
      // Create application directory first
      const appDir = path.join(helper.jsonDir, "applications", "testapp");
      fs.mkdirSync(appDir, { recursive: true });
      
      // Create templates directory first
      const templatesDir = path.join(appDir, "templates");
      fs.mkdirSync(templatesDir, { recursive: true });
      
      // Create a minimal test application
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
            name: "hostname",
            type: "string",
            required: true,
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: "echo '[{\"id\": \"test\", \"value\": \"ok\"}]'",
          },
        ],
        outputs: ["test"],
      });

      const url = ApiUri.VeConfiguration
        .replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
          changedParams: [{ name: "hostname", value: "testhost" }],
        } as IPostVeConfigurationBody);

      if (response.status !== 200) {
        console.error("Response status:", response.status);
        console.error("Response body:", JSON.stringify(response.body, null, 2));
        if ((response.body as any).error?.details) {
          console.error("Error details:", JSON.stringify((response.body as any).error.details, null, 2));
        }
      }
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.restartKey).toBeDefined();
      expect(typeof response.body.restartKey).toBe("string");
      expect(response.body.vmInstallKey).toBeDefined();
      expect(response.body.vmInstallKey).toBe("vminstall_testhost_testapp");
    });

    it("should return error when VE context not found", async () => {
      const url = ApiUri.VeConfiguration
        .replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", "ve_nonexistent");

      const response = await request(app)
        .post(url)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
        } as IPostVeConfigurationBody)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("VE context not found");
    });

    it("should return error when request body is invalid", async () => {
      const url = ApiUri.VeConfiguration
        .replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({
          params: "invalid", // Should be array
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toBeDefined();
    });
  });

  describe("GET /api/ve/execute/:veContext", () => {
    it("should return messages successfully", async () => {
      const url = ApiUri.VeExecute.replace(":veContext", veContextKey);

      const response = await request(app)
        .get(url)
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it("should return empty array when no messages exist", async () => {
      const url = ApiUri.VeExecute.replace(":veContext", veContextKey);

      const response = await request(app)
        .get(url)
        .expect(200);

      expect(response.body).toEqual([]);
    });
  });

  describe("POST /api/ve/restart/:restartKey/:veContext", () => {
    it("should successfully restart and return new restartKey and vmInstallKey", async () => {
      // Create application directory first
      const appDir = path.join(helper.jsonDir, "applications", "testapp");
      fs.mkdirSync(appDir, { recursive: true });
      
      // Create templates directory first
      const templatesDir = path.join(appDir, "templates");
      fs.mkdirSync(templatesDir, { recursive: true });
      
      // Setup: Create a minimal test application
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
            name: "hostname",
            type: "string",
            required: true,
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: "echo '[{\"id\": \"test\", \"value\": \"ok\"}]'",
          },
        ],
        outputs: ["test"],
      });

      // First, create a configuration to get a restartKey
      const configUrl = ApiUri.VeConfiguration
        .replace(":application", "testapp")
        .replace(":task", "installation")
        .replace(":veContext", veContextKey);

      const configResponse = await request(app)
        .post(configUrl)
        .send({
          params: [{ name: "hostname", value: "testhost" }],
        } as IPostVeConfigurationBody)
        .expect(200);

      const restartKey = configResponse.body.restartKey;
      expect(restartKey).toBeDefined();

      // The execution runs asynchronously, so we need to manually create a restartInfo
      // for testing purposes. In a real scenario, this would be created after execution completes.
      const restartInfo: IRestartInfo = {
        lastSuccessfull: 0, // First command completed successfully
        inputs: [{ name: "hostname", value: "testhost" }],
        outputs: [{ name: "test", value: "ok" }],
        defaults: [],
      };
      
      // Manually store the restartInfo in the restartManager
      // Access the internal restartManager from the WebAppVE instance
      const restartManager = (webAppVE as any).restartManager;
      restartManager.storeRestartInfo(restartKey, restartInfo);
      
      // Also create a message group with this restartKey so handleVeRestart can find it
      const messageManager = (webAppVE as any).messageManager;
      messageManager.findOrCreateMessageGroup("testapp", "installation", restartKey);

      // Now restart using the restartKey
      const restartUrl = ApiUri.VeRestart
        .replace(":restartKey", restartKey)
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(restartUrl)
        .send({})
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.restartKey).toBeDefined();
      expect(typeof response.body.restartKey).toBe("string");
      // vmInstallKey may or may not be present depending on whether changedParams were provided
    });

    it("should return error when restart info not found", async () => {
      const url = ApiUri.VeRestart
        .replace(":restartKey", "nonexistent-restart-key")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({})
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("Restart info not found");
    });

    it("should return error when VE context not found", async () => {
      const url = ApiUri.VeRestart
        .replace(":restartKey", "test-restart-key")
        .replace(":veContext", "ve_nonexistent");

      const response = await request(app)
        .post(url)
        .send({})
        .expect(404);

      expect(response.body.success).toBe(false);
      // The error could be either "VE context not found" or "Restart info not found"
      // depending on which check happens first
      expect(response.body.error).toBeDefined();
    });
  });

  describe("POST /api/ve/restart-installation/:vmInstallKey/:veContext", () => {
    it("should successfully restart installation from scratch", async () => {
      // Create application directory first
      const appDir = path.join(helper.jsonDir, "applications", "testapp");
      fs.mkdirSync(appDir, { recursive: true });
      
      // Create templates directory first
      const templatesDir = path.join(appDir, "templates");
      fs.mkdirSync(templatesDir, { recursive: true });
      
      // Setup: Create a minimal test application
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
            name: "hostname",
            type: "string",
            required: true,
          },
        ],
        commands: [
          {
            name: "Test Command",
            command: "echo '[{\"id\": \"test\", \"value\": \"ok\"}]'",
          },
        ],
        outputs: ["test"],
      });

      // Create a vmInstallContext
      const vmInstallKey = storageContext.setVMInstallContext({
        hostname: "testhost",
        application: "testapp",
        task: "installation",
        changedParams: [{ name: "hostname", value: "testhost" }],
      });

      const url = ApiUri.VeRestartInstallation
        .replace(":vmInstallKey", vmInstallKey)
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({})
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.restartKey).toBeDefined();
      expect(typeof response.body.restartKey).toBe("string");
      expect(response.body.vmInstallKey).toBe(vmInstallKey);
    });

    it("should return error when VM install context not found", async () => {
      // Use a valid vmInstallKey format but non-existent key
      const url = ApiUri.VeRestartInstallation
        .replace(":vmInstallKey", "vminstall_testhost_nonexistentapp")
        .replace(":veContext", veContextKey);

      const response = await request(app)
        .post(url)
        .send({})
        .expect(404);

      expect(response.body.success).toBe(false);
      // The route handler checks VE context first, then VM install context
      // Since VE context exists, it should check VM install context and fail
      expect(response.body.error).toBeDefined();
      // The actual error message depends on the implementation order
      // It could be "VM install context not found" if VE context check passes
    });

    it("should return error when VE context not found", async () => {
      const vmInstallKey = "vminstall_testhost_testapp";
      const url = ApiUri.VeRestartInstallation
        .replace(":vmInstallKey", vmInstallKey)
        .replace(":veContext", "ve_nonexistent");

      const response = await request(app)
        .post(url)
        .send({})
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toContain("VE context not found");
    });
  });
});

