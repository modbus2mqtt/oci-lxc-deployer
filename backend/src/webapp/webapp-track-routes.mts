import express from "express";
import { ApiUri, ITrack } from "../types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { PersistenceManager } from "../persistence/persistence-manager.mjs";

export class WebAppTrack {
  constructor(
    private app: express.Application,
    private contextManager: ContextManager,
  ) {}

  init(): void {
    // GET /api/tracktypes - List all tracktypes
    this.app.get(ApiUri.Tracktypes, (_req, res) => {
      const pm = PersistenceManager.getInstance();
      const tracktypes = pm.getTracktypes();
      res.json({ tracktypes });
    });

    // GET /api/tracks?tracktype=xxx - List all tracks (optionally filtered by tracktype)
    this.app.get(ApiUri.Tracks, (req, res) => {
      const tracktype = req.query.tracktype as string | undefined;
      const tracks = this.contextManager.listTracks(tracktype);
      res.json({ tracks });
    });

    // GET /api/track/:id - Get single track
    this.app.get(ApiUri.Track, (req, res) => {
      const track = this.contextManager.getTrack(req.params.id);
      if (!track) {
        res.status(404).json({ error: "Track not found" });
        return;
      }
      res.json({ track });
    });

    // POST /api/tracks - Create track
    this.app.post(ApiUri.Tracks, express.json(), (req, res) => {
      const body = req.body as ITrack;
      if (!body.id || !body.name || !body.tracktype) {
        res.status(400).json({ error: "Missing required fields: id, name, tracktype" });
        return;
      }
      const key = this.contextManager.addTrack(body);
      res.json({ success: true, key });
    });

    // DELETE /api/track/:id - Delete track
    this.app.delete(ApiUri.Track, (req, res) => {
      const deleted = this.contextManager.deleteTrack(req.params.id);
      res.json({ success: deleted, deleted });
    });
  }
}
