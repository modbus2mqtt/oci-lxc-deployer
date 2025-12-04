import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { VEWebApp } from "@src/webapp.mjs";
import express from "express";
import path from "node:path";
import { StorageContext } from "@src/storagecontext.mjs";
import { ApiUri } from "@src/types.mjs";
StorageContext.setInstance(path.join(__dirname, "../local/json"));
describe("ProxmoxWebApp", () => {
  let app: express.Application;

  const validSsh = { host: "localhost", port: 2222 };
  const invalidSsh = { host: 123, port: "not-a-number" };

  beforeAll(() => {
    app = new VEWebApp(StorageContext.getInstance()).app;
  });

  it("should return unresolved parameters for a valid application and task", async () => {
    const res = await request(app).get(
      "/api/getUnresolvedParameters/modbus2mqtt/installation",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.unresolvedParameters)).toBe(true);
  });

  it("should return error for missing application", async () => {
    const res = await request(app).get(
      "/api/getUnresolvedParameters/nonexistent/installation",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("should return error for missing task", async () => {
    const res = await request(app).get(
      "/api/getUnresolvedParameters/modbus2mqtt/nonexistenttask",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it("should include invalidApplication from jsonTest in the applications list", async () => {
    const res = await request(app).get("/api/applications");
    expect(res.status).toBe(200);
    const names = res.body.map((app: any) => app.id || app.name);
    expect(names).toContain("invalidApplication");
    const invalidApp = res.body.find(
      (app: any) => (app.id || app.name) === "invalidApplication",
    );
    expect(invalidApp).toBeDefined();
    expect(invalidApp.errors).toBeDefined();
    expect(Array.isArray(invalidApp.errors)).toBe(true);
    // Check that the error message contains "Template file not found:"
    const errorString = invalidApp.errors[0].message;
    expect(errorString).toContain("Template file not found:");
  });
  it("should return empty SSH configs", async () => {
    // Clean up config file if exists
    StorageContext.getInstance().remove("ve_localhost");  
    const res = await request(app).get(ApiUri.SshConfigs);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(0);
  });

  it("should set SSH config with POST and retrieve it with GET", async () => {
    const resPost = await request(app).post(ApiUri.SshConfig).send(validSsh);
    expect(resPost.status).toBe(200);
    expect(resPost.body.success).toBe(true);
    const resGet = await request(app).get(ApiUri.SshConfigs);
    expect(resGet.status).toBe(200);
    expect(Array.isArray(resGet.body)).toBe(true);
    expect(resGet.body.length).toBe(1);
    expect(resGet.body[0].host).toBe(validSsh.host);
  });

  it("should reject invalid SSH config (missing/invalid fields)", async () => {
    const res = await request(app).post("/api/sshconfig").send(invalidSsh);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });
});
