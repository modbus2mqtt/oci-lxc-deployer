/**
 * Tiny express server that powers the live `run-overview.html` viewer.
 *
 *   GET /events/<runId>     SSE stream of complete JSON snapshots, one frame
 *                           per scenario state transition + heartbeats.
 *   GET /run-overview.html  Static viewer (also lives in the run's outDir).
 *   GET /run-overview.json  Static JSON snapshot (also on disk).
 *
 * Only the current run is served. Concurrent runs collide on the port — we
 * log a warning and continue without SSE; the page then falls back to its
 * on-disk JSON file (which the runner still refreshes every minute).
 *
 * Lifecycle: started before scenarios run, stopped on runner exit. The HTML
 * page reconnects to JSON-on-disk for post-mortem viewing.
 */
import { createServer, type Server } from "node:http";
import path from "node:path";
import { readFileSync } from "node:fs";
import express, { type Request, type Response } from "express";
import { logInfo, logWarn } from "./log-helpers.mjs";
import {
  buildSnapshot,
  type RunOverviewSnapshot,
  type RunOverviewState,
} from "./run-overview.mjs";

const HEARTBEAT_MS = 15_000;

export interface RunOverviewServer {
  readonly url: string;
  readonly sseUrl: string;
  emit(state: RunOverviewState): void;
  stop(): Promise<void>;
}

/** Derive the overview server port from a deployer URL: `deployerPort + 10`. */
export function overviewPortForDeployer(deployerUrl: string): number {
  const override = process.env.LIVETEST_OVERVIEW_PORT;
  if (override) {
    const n = Number.parseInt(override, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  try {
    const u = new URL(deployerUrl);
    const p = Number.parseInt(u.port || (u.protocol === "https:" ? "443" : "80"), 10);
    if (Number.isFinite(p)) return p + 10;
  } catch { /* fall through */ }
  return 8090;
}

/**
 * Start the overview server. Returns `null` if the port is busy — the caller
 * should continue without live updates; the JSON-on-disk fallback still works.
 */
export async function startRunOverviewServer(
  state: RunOverviewState,
  port: number,
): Promise<RunOverviewServer | null> {
  const app = express();

  // Allow `file://` and any origin to read the SSE stream and JSON; this is a
  // local dev tool, no auth, no secrets.
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  });

  const clients = new Set<Response>();
  let lastSnapshot: RunOverviewSnapshot = buildSnapshot(state);

  app.get(`/events/${encodeURIComponent(state.runId)}`, (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    // Send the current snapshot immediately so a fresh client doesn't see an
    // empty page until the next transition.
    res.write(`data: ${JSON.stringify(lastSnapshot)}\n\n`);
    clients.add(res);
    _req.on("close", () => { clients.delete(res); });
  });

  // `/` defaults to the overview page. The full outDir is mounted as
  // static below so per-scenario links (e.g. `nginx-default/livetest-index.md`)
  // in the overview table resolve when the page is opened via http://.
  // Same content also lives on disk for the file:// post-mortem path.
  const serveFile = (filename: string, contentType: string) =>
    (_req: Request, res: Response): void => {
      try {
        const buf = readFileSync(path.join(state.outDir, filename));
        res.setHeader("Content-Type", contentType);
        res.send(buf);
      } catch {
        res.status(404).send("not found");
      }
    };
  app.get("/", serveFile("run-overview.html", "text/html; charset=utf-8"));
  app.use(express.static(state.outDir, {
    // index: false so a request for a directory doesn't show a listing —
    // we deliberately don't serve directory indexes (privacy + the only
    // top-level page worth showing is the overview, handled by GET /).
    index: false,
    setHeaders: (res, filePath) => {
      res.setHeader("Cache-Control", "no-cache");
      // Express's default mime for `.md` is `text/plain`, which means
      // browser markdown-viewer extensions don't trigger. Force the
      // proper IANA type so they render the file as a document.
      if (filePath.endsWith(".md")) {
        res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      }
    },
  }));

  const httpServer: Server = createServer(app);

  const started = await new Promise<boolean>((resolve) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      httpServer.off("listening", onListen);
      logWarn(`Run-overview server could not bind port ${port} (${err.code ?? err.message}); live updates disabled, JSON fallback only`);
      resolve(false);
    };
    const onListen = (): void => {
      httpServer.off("error", onError);
      resolve(true);
    };
    httpServer.once("error", onError);
    httpServer.once("listening", onListen);
    httpServer.listen(port, "0.0.0.0");
  });

  if (!started) return null;

  const heartbeat = setInterval(() => {
    for (const c of clients) {
      try { c.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* swallow */ }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  const url = `http://localhost:${port}`;
  const sseUrl = `${url}/events/${encodeURIComponent(state.runId)}`;
  logInfo(`Run-overview live server: ${url}/run-overview.html (SSE: ${sseUrl})`);

  return {
    url,
    sseUrl,
    emit(currentState: RunOverviewState): void {
      lastSnapshot = buildSnapshot(currentState);
      const frame = `data: ${JSON.stringify(lastSnapshot)}\n\n`;
      for (const c of clients) {
        try { c.write(frame); } catch { /* swallow */ }
      }
    },
    async stop(): Promise<void> {
      clearInterval(heartbeat);
      for (const c of clients) {
        try { c.end(); } catch { /* swallow */ }
      }
      clients.clear();
      await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
    },
  };
}
