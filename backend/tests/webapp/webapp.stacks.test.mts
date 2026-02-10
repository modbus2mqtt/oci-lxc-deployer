import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { ApiUri } from "@src/types.mjs";
import {
  createWebAppTestSetup,
  type WebAppTestSetup,
} from "../helper/webapp-test-helper.mjs";

describe("Stack API", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;

  beforeEach(() => {
    setup = createWebAppTestSetup(import.meta.url);
    app = setup.app;
  });

  afterEach(() => {
    setup.cleanup();
  });

  describe("POST /api/stacks", () => {
    it("creates a new stack and stores it in context", async () => {
      const stack = {
        id: "stack1",
        name: "Test Stack",
        stacktype: "music",
        entries: [{ name: "artist", value: "Test Artist" }],
      };
      const res = await request(app).post(ApiUri.Stacks).send(stack);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.key).toBe("stack_Test Stack");

      // Verify stack is stored in context
      const storedStack = setup.ctx.getStack("Test Stack");
      expect(storedStack).not.toBeNull();
      expect(storedStack?.id).toBe("stack1");
      expect(storedStack?.name).toBe("Test Stack");
      expect(storedStack?.stacktype).toBe("music");
      expect(storedStack?.entries).toEqual([
        { name: "artist", value: "Test Artist" },
      ]);
    });

    it("auto-generates id from name when not provided", async () => {
      const res = await request(app)
        .post(ApiUri.Stacks)
        .send({ name: "Test", stacktype: "music", entries: [] });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.key).toBe("stack_Test");
    });

    it("returns error for missing name", async () => {
      const res = await request(app)
        .post(ApiUri.Stacks)
        .send({ id: "t1", stacktype: "music", entries: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing required fields");
    });

    it("returns error for missing stacktype", async () => {
      const res = await request(app)
        .post(ApiUri.Stacks)
        .send({ id: "t1", name: "Test", entries: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing required fields");
    });
  });

  describe("GET /api/stacks", () => {
    it("returns empty list initially", async () => {
      const res = await request(app).get(ApiUri.Stacks);
      expect(res.status).toBe(200);
      expect(res.body.stacks).toEqual([]);
    });

    it("returns all stacks", async () => {
      await request(app).post(ApiUri.Stacks).send({
        id: "t1",
        name: "Stack 1",
        stacktype: "music",
        entries: [],
      });
      await request(app).post(ApiUri.Stacks).send({
        id: "t2",
        name: "Stack 2",
        stacktype: "video",
        entries: [],
      });

      const res = await request(app).get(ApiUri.Stacks);
      expect(res.status).toBe(200);
      expect(res.body.stacks.length).toBe(2);
    });

    it("filters by stacktype", async () => {
      await request(app).post(ApiUri.Stacks).send({
        id: "t1",
        name: "Stack 1",
        stacktype: "music",
        entries: [],
      });
      await request(app).post(ApiUri.Stacks).send({
        id: "t2",
        name: "Stack 2",
        stacktype: "video",
        entries: [],
      });
      await request(app).post(ApiUri.Stacks).send({
        id: "t3",
        name: "Stack 3",
        stacktype: "music",
        entries: [],
      });

      const res = await request(app).get(`${ApiUri.Stacks}?stacktype=music`);
      expect(res.status).toBe(200);
      expect(res.body.stacks.length).toBe(2);
      expect(
        res.body.stacks.every(
          (t: { stacktype: string }) => t.stacktype === "music",
        ),
      ).toBe(true);
    });

    it("returns empty list when filtering by non-existent stacktype", async () => {
      await request(app).post(ApiUri.Stacks).send({
        id: "t1",
        name: "Stack 1",
        stacktype: "music",
        entries: [],
      });

      const res = await request(app).get(
        `${ApiUri.Stacks}?stacktype=nonexistent`,
      );
      expect(res.status).toBe(200);
      expect(res.body.stacks).toEqual([]);
    });
  });

  describe("GET /api/stack/:id", () => {
    it("returns 404 for non-existent stack", async () => {
      const res = await request(app).get(
        ApiUri.Stack.replace(":id", "unknown"),
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Stack not found");
    });

    it("returns stack by name", async () => {
      await request(app)
        .post(ApiUri.Stacks)
        .send({
          id: "mystack",
          name: "My Stack",
          stacktype: "audio",
          entries: [{ name: "duration", value: 180 }],
        });

      const res = await request(app).get(
        ApiUri.Stack.replace(":id", "My Stack"),
      );
      expect(res.status).toBe(200);
      expect(res.body.stack.id).toBe("mystack");
      expect(res.body.stack.name).toBe("My Stack");
      expect(res.body.stack.stacktype).toBe("audio");
      expect(res.body.stack.entries).toEqual([
        { name: "duration", value: 180 },
      ]);
    });

    it("returns stack by key with stack_ prefix", async () => {
      await request(app).post(ApiUri.Stacks).send({
        id: "mystack",
        name: "My Stack",
        stacktype: "audio",
        entries: [],
      });

      const res = await request(app).get(
        ApiUri.Stack.replace(":id", "stack_My Stack"),
      );
      expect(res.status).toBe(200);
      expect(res.body.stack.name).toBe("My Stack");
    });
  });

  describe("DELETE /api/stack/:id", () => {
    it("deletes existing stack from context", async () => {
      await request(app).post(ApiUri.Stacks).send({
        id: "todelete",
        name: "Delete Me",
        stacktype: "test",
        entries: [],
      });

      // Verify stack exists in context before deletion
      expect(setup.ctx.getStack("Delete Me")).not.toBeNull();

      const res = await request(app).delete(
        ApiUri.Stack.replace(":id", "Delete Me"),
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deleted).toBe(true);

      // Verify stack is removed from context
      expect(setup.ctx.getStack("Delete Me")).toBeNull();

      // Verify via API as well
      const getRes = await request(app).get(
        ApiUri.Stack.replace(":id", "Delete Me"),
      );
      expect(getRes.status).toBe(404);
    });

    it("returns deleted=false for non-existent stack", async () => {
      const res = await request(app).delete(
        ApiUri.Stack.replace(":id", "nonexistent"),
      );
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.deleted).toBe(false);
    });

    it("deletes stack using stack_ prefix and removes from context", async () => {
      await request(app).post(ApiUri.Stacks).send({
        id: "todelete",
        name: "Delete Me",
        stacktype: "test",
        entries: [],
      });

      // Verify stack exists in context
      expect(setup.ctx.getStack("Delete Me")).not.toBeNull();

      const res = await request(app).delete(
        ApiUri.Stack.replace(":id", "stack_Delete Me"),
      );
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);

      // Verify stack is removed from context
      expect(setup.ctx.getStack("Delete Me")).toBeNull();
    });
  });

  describe("GET /api/stacktypes", () => {
    it("returns empty list when no stacktypes.json exists", async () => {
      const res = await request(app).get(ApiUri.Stacktypes);
      expect(res.status).toBe(200);
      expect(res.body.stacktypes).toEqual([]);
    });
  });
});
