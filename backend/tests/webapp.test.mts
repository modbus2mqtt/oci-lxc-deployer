import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { ProxmoxWebApp } from "@src/webapp.mjs";
import express from "express";
import fs from "node:fs";
import path from "node:path";

describe("ProxmoxWebApp", () => {
  let app: express.Application;
  let schemaPath: string;
  let jsonPath: string;
  let jsonTestPath: string;
  const validSsh = { host: "localhost", port: 2222 };
  const invalidSsh = { host: 123, port: "not-a-number" };

  beforeAll(() => {
    schemaPath = path.join(__dirname, "../schemas");
    jsonPath = path.join(__dirname, "../json");
    jsonTestPath = path.join(__dirname, "../local/json");
    app = new ProxmoxWebApp(schemaPath, jsonPath, jsonTestPath).app;
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
  it("should return 404 if SSH config is not set", async () => {
    // Clean up config file if exists

    const file = path.join(process.cwd(), "local", "sshconfig.json");
    if (fs.existsSync(file)) fs.unlinkSync(file);
    const res = await request(app).get("/api/sshconfig");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not set/i);
  });

  it("should set SSH config with POST and retrieve it with GET", async () => {
    const resPost = await request(app).post("/api/sshconfig").send(validSsh);
    expect(resPost.status).toBe(200);
    expect(resPost.body.success).toBe(true);
    const resGet = await request(app).get("/api/sshconfig");
    expect(resGet.status).toBe(200);
    expect(resGet.body).toEqual(validSsh);
  });

  it("should reject invalid SSH config (missing/invalid fields)", async () => {
    const res = await request(app).post("/api/sshconfig").send(invalidSsh);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });
});
