import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";
import { ApiUri } from "@src/types.mjs";
import { createWebAppTestSetup, type WebAppTestSetup } from "../helper/webapp-test-helper.mjs";

describe("Track API", () => {
  let app: express.Application;
  let setup: WebAppTestSetup;

  beforeEach(() => {
    setup = createWebAppTestSetup(import.meta.url);
    app = setup.app;
  });

  afterEach(() => {
    setup.cleanup();
  });

  describe("POST /api/tracks", () => {
    it("creates a new track", async () => {
      const track = {
        id: "track1",
        name: "Test Track",
        tracktype: "music",
        entries: [{ name: "artist", value: "Test Artist" }],
      };
      const res = await request(app).post(ApiUri.Tracks).send(track);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.key).toBe("track_Test Track");
    });

    it("returns error for missing id", async () => {
      const res = await request(app)
        .post(ApiUri.Tracks)
        .send({ name: "Test", tracktype: "music", entries: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing required fields");
    });

    it("returns error for missing name", async () => {
      const res = await request(app)
        .post(ApiUri.Tracks)
        .send({ id: "t1", tracktype: "music", entries: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing required fields");
    });

    it("returns error for missing tracktype", async () => {
      const res = await request(app)
        .post(ApiUri.Tracks)
        .send({ id: "t1", name: "Test", entries: [] });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Missing required fields");
    });
  });

  describe("GET /api/tracks", () => {
    it("returns empty list initially", async () => {
      const res = await request(app).get(ApiUri.Tracks);
      expect(res.status).toBe(200);
      expect(res.body.tracks).toEqual([]);
    });

    it("returns all tracks", async () => {
      await request(app).post(ApiUri.Tracks).send({
        id: "t1",
        name: "Track 1",
        tracktype: "music",
        entries: [],
      });
      await request(app).post(ApiUri.Tracks).send({
        id: "t2",
        name: "Track 2",
        tracktype: "video",
        entries: [],
      });

      const res = await request(app).get(ApiUri.Tracks);
      expect(res.status).toBe(200);
      expect(res.body.tracks.length).toBe(2);
    });

    it("filters by tracktype", async () => {
      await request(app).post(ApiUri.Tracks).send({
        id: "t1",
        name: "Track 1",
        tracktype: "music",
        entries: [],
      });
      await request(app).post(ApiUri.Tracks).send({
        id: "t2",
        name: "Track 2",
        tracktype: "video",
        entries: [],
      });
      await request(app).post(ApiUri.Tracks).send({
        id: "t3",
        name: "Track 3",
        tracktype: "music",
        entries: [],
      });

      const res = await request(app).get(`${ApiUri.Tracks}?tracktype=music`);
      expect(res.status).toBe(200);
      expect(res.body.tracks.length).toBe(2);
      expect(res.body.tracks.every((t: { tracktype: string }) => t.tracktype === "music")).toBe(true);
    });

    it("returns empty list when filtering by non-existent tracktype", async () => {
      await request(app).post(ApiUri.Tracks).send({
        id: "t1",
        name: "Track 1",
        tracktype: "music",
        entries: [],
      });

      const res = await request(app).get(`${ApiUri.Tracks}?tracktype=nonexistent`);
      expect(res.status).toBe(200);
      expect(res.body.tracks).toEqual([]);
    });
  });

  describe("GET /api/track/:id", () => {
    it("returns 404 for non-existent track", async () => {
      const res = await request(app).get(ApiUri.Track.replace(":id", "unknown"));
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Track not found");
    });

    it("returns track by name", async () => {
      await request(app).post(ApiUri.Tracks).send({
        id: "mytrack",
        name: "My Track",
        tracktype: "audio",
        entries: [{ name: "duration", value: 180 }],
      });

      const res = await request(app).get(ApiUri.Track.replace(":id", "My Track"));
      expect(res.status).toBe(200);
      expect(res.body.track.id).toBe("mytrack");
      expect(res.body.track.name).toBe("My Track");
      expect(res.body.track.tracktype).toBe("audio");
      expect(res.body.track.entries).toEqual([{ name: "duration", value: 180 }]);
    });

    it("returns track by key with track_ prefix", async () => {
      await request(app).post(ApiUri.Tracks).send({
        id: "mytrack",
        name: "My Track",
        tracktype: "audio",
        entries: [],
      });

      const res = await request(app).get(ApiUri.Track.replace(":id", "track_My Track"));
      expect(res.status).toBe(200);
      expect(res.body.track.name).toBe("My Track");
    });
  });

  describe("DELETE /api/track/:id", () => {
    it("deletes existing track", async () => {
      await request(app).post(ApiUri.Tracks).send({
        id: "todelete",
        name: "Delete Me",
        tracktype: "test",
        entries: [],
      });

      const res = await request(app).delete(ApiUri.Track.replace(":id", "Delete Me"));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.deleted).toBe(true);

      // Verify deletion
      const getRes = await request(app).get(ApiUri.Track.replace(":id", "Delete Me"));
      expect(getRes.status).toBe(404);
    });

    it("returns deleted=false for non-existent track", async () => {
      const res = await request(app).delete(ApiUri.Track.replace(":id", "nonexistent"));
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(false);
      expect(res.body.deleted).toBe(false);
    });

    it("deletes track using track_ prefix", async () => {
      await request(app).post(ApiUri.Tracks).send({
        id: "todelete",
        name: "Delete Me",
        tracktype: "test",
        entries: [],
      });

      const res = await request(app).delete(ApiUri.Track.replace(":id", "track_Delete Me"));
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });
  });

  describe("GET /api/tracktypes", () => {
    it("returns empty list when no tracktypes.json exists", async () => {
      const res = await request(app).get(ApiUri.Tracktypes);
      expect(res.status).toBe(200);
      expect(res.body.tracktypes).toEqual([]);
    });
  });
});
