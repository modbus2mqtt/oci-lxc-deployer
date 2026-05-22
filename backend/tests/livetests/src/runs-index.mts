/**
 * `livetest-results/index.html` generator + retention sweeper.
 *
 * Called once at the start of every livetest run:
 *   1. Delete result directories older than `maxAgeHours` (default 3 h),
 *      identified by their `<unix-seconds>-…` runId prefix. mtime is
 *      unreliable (touched on every file write inside the dir during the
 *      run), so the embedded timestamp is the source of truth.
 *   2. Read every surviving `<dir>/run-overview.json` for status counts +
 *      command line, and write a single `livetest-results/index.html`
 *      sorted newest-first. Older directories without a JSON snapshot
 *      (pre-feature) are listed with degraded metadata.
 *
 * The index is intentionally static — it captures the state at the moment
 * the current runner started. Live updates of past runs are out of scope;
 * the index is a directory listing, not another dashboard.
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

interface RunSummary {
  runId: string;
  dir: string;
  startedUnix: number;
  startedAtIso: string | null;
  commandLine: string | null;
  /** Last positional argument from commandLine — what the user actually
   * asked for ("--all", "nginx/default", "@e2e/snapshot-baseline.lst"). */
  testArg: string | null;
  totalPlanned: number | null;
  counts: {
    passed: number;
    failed: number;
    skipped: number;
    restored: number;
    running: number;
    pending: number;
  } | null;
  /** IDs of scenarios with status === "failed" in the latest snapshot. */
  failedIds: string[];
}

const RUN_ID_PREFIX = /^(\d+)-/;

export function cleanupOldRuns(resultsRoot: string, maxAgeHours = 3): number {
  let removed = 0;
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeHours * 3600;
  let entries: string[];
  try { entries = readdirSync(resultsRoot); } catch { return 0; }
  for (const name of entries) {
    const m = RUN_ID_PREFIX.exec(name);
    if (!m) continue;
    const ts = Number(m[1]);
    if (!Number.isFinite(ts) || ts >= cutoff) continue;
    const dir = path.join(resultsRoot, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch { /* best-effort */ }
  }
  return removed;
}

function extractTestArg(commandLine: string | null): string | null {
  if (!commandLine) return null;
  // Quick-and-cheap: take the last whitespace-separated token. The runner
  // always invokes as `node|tsx … runner.mjs <instance> <testArg> [flags…]`,
  // but with flags trailing the last token is the test filter often enough
  // to be useful as a hint. Falls back to null when there's nothing usable.
  const parts = commandLine.trim().split(/\s+/);
  for (let i = parts.length - 1; i >= 0; i--) {
    const t = parts[i]!;
    if (t.startsWith("--") || t.startsWith("-") || /^\d+$/.test(t)) continue;
    if (t === "yellow" || t === "green") continue;
    return t;
  }
  return parts[parts.length - 1] ?? null;
}

function readSummary(resultsRoot: string, runId: string): RunSummary {
  const dir = path.join(resultsRoot, runId);
  const m = RUN_ID_PREFIX.exec(runId);
  const startedUnix = m ? Number(m[1]) : 0;
  const base: RunSummary = {
    runId, dir, startedUnix,
    startedAtIso: null, commandLine: null, testArg: null,
    totalPlanned: null, counts: null, failedIds: [],
  };
  try {
    const jsonPath = path.join(dir, "run-overview.json");
    const raw = readFileSync(jsonPath, "utf8");
    const j = JSON.parse(raw) as {
      startedAt?: string;
      commandLine?: string;
      totalPlanned?: number;
      counts?: RunSummary["counts"];
      scenarios?: Array<{ id: string; status: string }>;
    };
    const failedIds = (j.scenarios ?? [])
      .filter((s) => s.status === "failed")
      .map((s) => s.id);
    return {
      ...base,
      startedAtIso: j.startedAt ?? null,
      commandLine: j.commandLine ?? null,
      testArg: extractTestArg(j.commandLine ?? null),
      totalPlanned: j.totalPlanned ?? null,
      counts: j.counts ?? null,
      failedIds,
    };
  } catch {
    return base;
  }
}

export function writeRunsIndex(resultsRoot: string): void {
  let entries: string[];
  try { entries = readdirSync(resultsRoot); } catch { return; }
  const runs = entries
    .filter((name) => RUN_ID_PREFIX.test(name))
    .map((name) => readSummary(resultsRoot, name))
    .sort((a, b) => b.startedUnix - a.startedUnix);
  try {
    writeFileSync(path.join(resultsRoot, "index.html"), renderIndexHtml(runs));
  } catch { /* best-effort */ }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function renderIndexHtml(runs: RunSummary[]): string {
  const rows = runs.map((r) => {
    const time = r.startedUnix > 0
      ? new Date(r.startedUnix * 1000).toLocaleString()
      : "—";
    const linkHref = `${encodeURIComponent(r.runId)}/run-overview.html`;
    const c = r.counts;
    const status = c
      ? `<span class="b-passed">✓ ${c.passed}</span> · `
      + `<span class="b-failed">✗ ${c.failed}</span> · `
      + `<span class="b-skipped">⊘ ${c.skipped}</span> · `
      + `<span class="b-restored">↺ ${c.restored}</span> · `
      + `<span class="b-running">▶ ${c.running}</span> · `
      + `<span class="b-pending">⏳ ${c.pending}</span>`
      + (r.totalPlanned != null ? ` <span class="dim">of ${r.totalPlanned}</span>` : "")
      : `<span class="dim">no snapshot (pre-feature run)</span>`;
    // Failed-scenarios list (each linked to its per-scenario index.md so
    // the user can jump straight into the debug bundle). Empty when no
    // failures or when the JSON is missing.
    const failedList = r.failedIds.length === 0
      ? ""
      : `<ul class="failed">${r.failedIds.map((sid) => {
          const slug = sid.replace(/\//g, "-");
          const href = `${encodeURIComponent(r.runId)}/${encodeURIComponent(slug)}/livetest-index.md`;
          return `<li><a href="${href}">${escapeHtml(sid)}</a></li>`;
        }).join("")}</ul>`;
    const testArgCell = r.testArg ? `<code class="test">${escapeHtml(r.testArg)}</code>` : "—";
    return `<tr>
      <td class="time">${escapeHtml(time)}</td>
      <td><a href="${linkHref}">${escapeHtml(r.runId)}</a></td>
      <td>${testArgCell}</td>
      <td class="status">${status}</td>
      <td>${failedList}</td>
    </tr>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Livetest runs</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 1.5rem; color: #222; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  .hint { color: #666; font-size: .85rem; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; font-size: .92rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #fafafa; font-weight: 600; }
  td.time { white-space: nowrap; font-variant-numeric: tabular-nums; }
  td.status { white-space: nowrap; }
  .b-passed   { color: #195819; }
  .b-failed   { color: #8a1212; }
  .b-skipped  { color: #6b4a12; }
  .b-restored { color: #4a2b88; }
  .b-running  { color: #1644a8; }
  .b-pending  { color: #555; }
  .dim { color: #999; }
  code.cmd, code.test { background: #f3f3f3; padding: .1rem .35rem; border-radius: 3px; font-size: .85rem;
             white-space: nowrap; display: inline-block; }
  ul.failed { margin: 0; padding-left: 1rem; }
  ul.failed li { color: #8a1212; }
  .empty { color: #666; padding: 1rem 0; }
</style>
</head>
<body>
<h1>Livetest runs</h1>
<div class="hint">${runs.length} run(s) on disk · runs older than 3 hours are deleted at the start of every new run · click a row to open its overview</div>
${runs.length === 0 ? '<div class="empty">No runs available.</div>' : `<table>
  <thead><tr><th>Started</th><th>Run ID</th><th>Test</th><th>Status</th><th>Failed scenarios</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`}
</body>
</html>
`;
}
