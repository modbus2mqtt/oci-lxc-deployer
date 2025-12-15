import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { VEWebApp } from "@src/webapp.mjs";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { StorageContext } from "@src/storagecontext.mjs";
import { ApiUri } from "@src/types.mjs";

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lxc-manager-test-"));
  // Prepare json/schema dirs to avoid errors where needed
  fs.mkdirSync(path.join(dir, "json"), { recursive: true });
  fs.mkdirSync(path.join(dir, "schemas"), { recursive: true });
  return dir;
}

describe("WebApp API", () => {
  let app: express.Application;
  let tmp: string;

  beforeEach(() => {
    tmp = createTempDir();
    StorageContext.setInstance(path.join(tmp));
    app = new VEWebApp(StorageContext.getInstance()).app;
  });

  describe("SshConfigs GET", () => {
    it("returns key when a current is set and multiple ssh exist", async () => {
      await request(app).post(ApiUri.SshConfig).send({ host: "host1", port: 22 });
      await request(app).post(ApiUri.SshConfig).send({ host: "host2", port: 2202, current: true });
      const res = await request(app).get(ApiUri.SshConfigs);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sshs)).toBe(true);
      expect(res.body.sshs.length).toBeGreaterThan(1);
      expect(res.body.key).toBeDefined();
    });

    it("returns undefined key when no current is set", async () => {
      await request(app).post(ApiUri.SshConfig).send({ host: "host1", port: 22, current: false });
      await request(app).post(ApiUri.SshConfig).send({ host: "host2", port: 2202, current: false });
      const res = await request(app).get(ApiUri.SshConfigs);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.sshs)).toBe(true);
      expect(res.body.key).toBeUndefined();
    });
  });

  describe("SshConfig GET/PUT/POST", () => {
    it("GET: returns key ve_$host for existing config", async () => {
      await request(app).post(ApiUri.SshConfig).send({ host: "hostX", port: 22 });
      const res = await request(app).get(`${ApiUri.SshConfig}?host=hostX`);
      expect(res.status).toBe(200);
      expect(res.body.key).toBe("ve_hostX");
    });

    it("POST: with current=true returns key", async () => {
      const res = await request(app).post(ApiUri.SshConfig).send({ host: "hostP", port: 22, current: true });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.key).toBe("ve_hostP");
    });

    it("POST: without current returns no key", async () => {
      const res = await request(app).post(ApiUri.SshConfig).send({ host: "hostQ", port: 2202 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.key).toBeUndefined();
    });

    it("PUT: sets current and returns key", async () => {
      await request(app).post(ApiUri.SshConfig).send({ host: "hostR", port: 22 });
      const res = await request(app).put(ApiUri.SshConfig).send({ host: "hostR" });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.key).toBe("ve_hostR");
    });
  });

  describe("SshCheck", () => {
    it("success case", async () => {
      const mod = await import("@src/ssh.mjs");
      vi.spyOn(mod.Ssh, "checkSshPermission").mockReturnValue({ permissionOk: true });
      const res = await request(app).get(`${ApiUri.SshCheck}?host=anyhost&port=22`);
      expect(res.status).toBe(200);
      expect(res.body.permissionOk).toBe(true);
    });

    it("error case", async () => {
      const mod = await import("@src/ssh.mjs");
      vi.spyOn(mod.Ssh, "checkSshPermission").mockReturnValue({ permissionOk: false, stderr: "denied" });
      const res = await request(app).get(`${ApiUri.SshCheck}?host=anyhost&port=22`);
      expect(res.status).toBe(200);
      expect(res.body.permissionOk).toBe(false);
      expect(res.body.stderr).toBeDefined();
    });
  });
});
