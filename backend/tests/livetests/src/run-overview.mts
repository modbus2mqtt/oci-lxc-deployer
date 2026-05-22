/**
 * Live-updated run overview.
 *
 * Two artifacts in `<outDir>`:
 *   - `run-overview.html` — static viewer, written once at run start.
 *     When opened via the runner's express server (`http://host:port/...`)
 *     it subscribes to an SSE stream and updates live. When opened from the
 *     filesystem (`file://`) it fetches `run-overview.json` once — the
 *     post-mortem path.
 *   - `run-overview.json` — JSON snapshot of the run. Initial write at start,
 *     refreshed once per minute by the runner, and a final write on exit
 *     so the view survives the runner.
 *
 * Best-effort: any IO error during write is swallowed — the overview is
 * observability, never the source of truth.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { PlannedScenario } from "./livetest-types.mjs";

export type ScenarioStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "restored";

export interface RunOverviewState {
  outDir: string;
  runId: string;
  startedAt: Date;
  commandLine: string;
  planned: PlannedScenario[];
  status: Map<string, ScenarioStatus>;
  startedAtMap: Map<string, Date>;
  finishedAtMap: Map<string, Date>;
  storage: Map<string, string>;
  errorMessages: Map<string, string>;
}

export interface ScenarioSnapshot {
  id: string;
  app: string;
  variant: string;
  ssl: boolean;
  oidc: boolean;
  mtls: boolean;
  storage: string | null;
  status: ScenarioStatus;
  /** Start time as ms-since-epoch (number for easy client-side sort), or null while pending. */
  startedAtMs: number | null;
  /** Finish time as ms-since-epoch, or null while still running/pending. */
  finishedAtMs: number | null;
  durationSec: number | null;
  error: string | null;
  indexPath: string;
}

export interface RunOverviewSnapshot {
  runId: string;
  startedAt: string;
  now: string;
  elapsedSec: number;
  commandLine: string;
  totalPlanned: number;
  counts: {
    passed: number;
    failed: number;
    skipped: number;
    restored: number;
    running: number;
    pending: number;
  };
  scenarios: ScenarioSnapshot[];
}

function hasTag(p: PlannedScenario, tag: string): boolean {
  const tags = [...(p.scenario.tags ?? []), ...(p.scenario.computedTags ?? [])];
  return tags.includes(tag);
}

function detectFeatures(p: PlannedScenario): { ssl: boolean; oidc: boolean; mtls: boolean } {
  const variant = (p.scenario.id.split("/")[1] ?? "").toLowerCase();
  return {
    // ssl covers both TLS-only (addon-ssl) and ACME-managed TLS (addon-acme),
    // and mtls variants imply SSL as their substrate.
    ssl: hasTag(p, "addon:ssl") || hasTag(p, "addon:acme") || /ssl|mtls/.test(variant),
    // OIDC: the addon, the oidc-consumer apps, or zitadel itself (the IdP).
    oidc: hasTag(p, "addon:oidc") || p.scenario.application === "zitadel" || /oidc/.test(variant),
    // No short-name addon for mtls — variant is the reliable signal.
    mtls: /mtls/.test(variant),
  };
}

function sanitizeScenarioId(id: string): string {
  return id.replace(/\//g, "-");
}

export function buildSnapshot(state: RunOverviewState, nowMs: number = Date.now()): RunOverviewSnapshot {
  const scenarios: ScenarioSnapshot[] = state.planned.map((p) => {
    const sid = p.scenario.id;
    const [app, variant = ""] = sid.split("/");
    const f = detectFeatures(p);
    const status: ScenarioStatus = state.status.get(sid) ?? "pending";
    const start = state.startedAtMap.get(sid);
    const end = state.finishedAtMap.get(sid);
    let durationSec: number | null = null;
    if (start && end) durationSec = (end.getTime() - start.getTime()) / 1000;
    else if (start && status === "running") durationSec = (nowMs - start.getTime()) / 1000;
    return {
      id: sid,
      app: app ?? sid,
      variant,
      ssl: f.ssl,
      oidc: f.oidc,
      mtls: f.mtls,
      storage: state.storage.get(sid) ?? null,
      status,
      startedAtMs: start ? start.getTime() : null,
      finishedAtMs: end ? end.getTime() : null,
      durationSec,
      error: state.errorMessages.get(sid) ?? null,
      indexPath: `${sanitizeScenarioId(sid)}/livetest-index.md`,
    };
  });

  let passed = 0, failed = 0, skipped = 0, restored = 0, running = 0;
  for (const s of state.status.values()) {
    if (s === "passed") passed++;
    else if (s === "failed") failed++;
    else if (s === "skipped") skipped++;
    else if (s === "restored") restored++;
    else if (s === "running") running++;
  }
  const pending = state.planned.length - passed - failed - skipped - restored - running;

  return {
    runId: state.runId,
    startedAt: state.startedAt.toISOString(),
    now: new Date(nowMs).toISOString(),
    elapsedSec: Math.floor((nowMs - state.startedAt.getTime()) / 1000),
    commandLine: state.commandLine,
    totalPlanned: state.planned.length,
    counts: { passed, failed, skipped, restored, running, pending },
    scenarios,
  };
}

export function writeRunOverviewJson(state: RunOverviewState): void {
  try {
    writeFileSync(
      path.join(state.outDir, "run-overview.json"),
      JSON.stringify(buildSnapshot(state), null, 2),
    );
  } catch { /* best-effort */ }
}

/**
 * Writes the static HTML viewer. Embeds RUN_ID and SSE_URL so the same file
 * works both server-served (live via SSE) and file:// (post-mortem via JSON).
 *
 * @param sseUrl Full URL of the SSE endpoint, e.g.
 *   `http://host:port/events/<runId>`. Pass `null` if the server didn't start —
 *   the page will skip the SSE attempt entirely.
 */
export function writeRunOverviewHtml(state: RunOverviewState, sseUrl: string | null): void {
  try {
    const html = renderHtml(state.runId, sseUrl);
    writeFileSync(path.join(state.outDir, "run-overview.html"), html);
  } catch { /* best-effort */ }
}

function renderHtml(runId: string, sseUrl: string | null): string {
  // Embedded as a single self-contained file: no build step, no external deps.
  // RUN_ID and SSE_URL are injected as JS constants; the page then decides
  // between live (SSE) and post-mortem (JSON) mode based on its own protocol.
  const sseLiteral = sseUrl ? JSON.stringify(sseUrl) : "null";
  const runIdLiteral = JSON.stringify(runId);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Livetest run ${escapeHtml(runId)}</title>
<style>
  body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 1.5rem; color: #222; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  .meta { color: #555; font-size: .9rem; line-height: 1.5; margin-bottom: 1rem; }
  .meta code { background: #f3f3f3; padding: .1rem .35rem; border-radius: 3px; }
  .badge { display: inline-block; padding: .1rem .45rem; border-radius: 999px; font-size: .8rem; font-weight: 500; }
  /* Status badges in the header act as filter toggles. Click a badge to
     hide all rows with that status; click again to show. The dimmed look
     signals which filter is active. */
  .meta .badge { cursor: pointer; user-select: none; }
  .meta .badge.filtered-out { opacity: .35; text-decoration: line-through; }
  table.hide-pending  tbody tr[data-status="pending"]  { display: none; }
  table.hide-running  tbody tr[data-status="running"]  { display: none; }
  table.hide-passed   tbody tr[data-status="passed"]   { display: none; }
  table.hide-failed   tbody tr[data-status="failed"]   { display: none; }
  table.hide-skipped  tbody tr[data-status="skipped"]  { display: none; }
  table.hide-restored tbody tr[data-status="restored"] { display: none; }
  .b-pending  { background: #eee; color: #555; }
  .b-running  { background: #d6e9ff; color: #1644a8; }
  .b-passed   { background: #d6f5d6; color: #195819; }
  .b-failed   { background: #ffd6d6; color: #8a1212; }
  .b-skipped  { background: #f0e0c8; color: #6b4a12; }
  .b-restored { background: #e2d8f5; color: #4a2b88; }
  table { border-collapse: collapse; font-size: .92rem; table-layout: fixed; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #eee;
           overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  th { background: #fafafa; font-weight: 600; cursor: pointer; user-select: none; }
  th:hover { background: #f0f0f0; }
  th .arrow { color: #999; font-size: .8em; margin-left: .25rem; }
  td.center, th.center { text-align: center; }
  td.num { font-variant-numeric: tabular-nums; }
  /* Fixed column widths (table-layout: fixed). Keeps the layout stable as
     SSE snapshots update — without it, cells reflow on every status change. */
  col.col-app      { width: 30ch; }
  col.col-scenario { width: 15ch; }
  col.col-flag     { width: 4ch; }      /* SSL / OIDC / mTLS – header-sized */
  col.col-storage  { width: 15ch; }
  col.col-status   { width: 15ch; }
  col.col-time     { width: 10ch; }     /* Start / End / Duration */
  .source { font-size: .85rem; color: #666; margin-left: .5rem; }
  .source.live { color: #1d7a1d; }
  .source.disconnected { color: #b04a00; }
  .errors { margin-top: 1rem; }
  .errors h2 { font-size: 1rem; }
  .errors li { margin-bottom: .3rem; }
  .cmd { white-space: pre-wrap; word-break: break-all; }
</style>
</head>
<body>
<h1>Livetest Run Overview <span id="source" class="source">loading…</span></h1>
<div class="meta">
  <div>Run&nbsp;ID: <code id="runId">${escapeHtml(runId)}</code></div>
  <div>Started: <span id="startedAt">—</span> · Elapsed: <span id="elapsed">—</span></div>
  <div>Status (click to hide):
    <span class="badge b-passed"   data-filter="passed"  title="Click to hide passed rows">✓ <span id="c-passed">0</span> passed</span>
    <span class="badge b-failed"   data-filter="failed"  title="Click to hide failed rows">✗ <span id="c-failed">0</span> failed</span>
    <span class="badge b-skipped"  data-filter="skipped" title="Click to hide skipped rows">⊘ <span id="c-skipped">0</span> skipped</span>
    <span class="badge b-restored" data-filter="restored" title="Click to hide restored rows">↺ <span id="c-restored">0</span> restored</span>
    <span class="badge b-running"  data-filter="running" title="Click to hide running rows">▶ <span id="c-running">0</span> running</span>
    <span class="badge b-pending"  data-filter="pending" title="Click to hide pending rows">⏳ <span id="c-pending">0</span> pending</span>
    of <span id="c-total">0</span>
  </div>
  <div>Command: <code class="cmd" id="cmd">—</code></div>
</div>
<table>
  <colgroup>
    <col class="col-app">
    <col class="col-scenario">
    <col class="col-flag">
    <col class="col-flag">
    <col class="col-flag">
    <col class="col-storage">
    <col class="col-status">
    <col class="col-time">
    <col class="col-time">
    <col class="col-time">
  </colgroup>
  <thead>
    <tr id="head">
      <th data-key="app">App</th>
      <th data-key="variant">Scenario</th>
      <th data-key="ssl" class="center">SSL</th>
      <th data-key="oidc" class="center">OIDC</th>
      <th data-key="mtls" class="center">mTLS</th>
      <th data-key="storage">Storage</th>
      <th data-key="status">Status</th>
      <th data-key="startedAtMs" class="center">Start</th>
      <th data-key="finishedAtMs" class="center">End</th>
      <th data-key="durationSec" class="center">Duration</th>
    </tr>
  </thead>
  <tbody id="rows"></tbody>
</table>
<div class="errors" id="errorsBox" style="display:none">
  <h2>Errors</h2>
  <ul id="errorsList"></ul>
</div>
<script>
const RUN_ID = ${runIdLiteral};
const SSE_URL = ${sseLiteral};

function badge(status) {
  const labels = { pending: '⏳ pending', running: '▶ running', passed: '✓ passed',
                   failed: '✗ failed', skipped: '⊘ skipped', restored: '↺ restored' };
  const cls = 'badge b-' + status;
  const label = labels[status] || status;
  const span = document.createElement('span');
  span.className = cls;
  span.textContent = label;
  return span;
}

function formatDurationFromCell(td) {
  // Compute duration from data-attrs (client-side) so a running scenario
  // can be ticked every second without a full snapshot round-trip, and a
  // finished scenario shows the precise duration even when the backend
  // snapshot is slightly stale.
  const status = td.dataset.status;
  const start = td.dataset.startedMs ? Number(td.dataset.startedMs) : null;
  const end = td.dataset.finishedMs ? Number(td.dataset.finishedMs) : null;
  if (start == null) return '';
  if (end != null) return ((end - start) / 1000).toFixed(1) + 's';
  if (status === 'running') return Math.round((Date.now() - start) / 1000) + 's …';
  return '';
}

function formatTime(ms, runStartMs) {
  if (ms == null || runStartMs == null) return '';
  // mm:ss relative to the run start, so the column reads as
  // "this scenario hit start/finish N minutes after the run began".
  const sec = Math.max(0, Math.round((ms - runStartMs) / 1000));
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return mm + ':' + String(ss).padStart(2, '0');
}

// Sort state: column key + direction. null/null = preserve planned order
// (the input array's natural order from the runner).
let sortKey = null;
let sortDir = 1; // 1 = asc, -1 = desc
let lastSnapshot = null;

function cmpVal(a, b) {
  if (a === b) return 0;
  // null / undefined sort last regardless of direction
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  return String(a).localeCompare(String(b));
}

function sortedScenarios(scenarios) {
  if (sortKey == null) return scenarios;
  const k = sortKey, dir = sortDir;
  return [...scenarios].sort((a, b) => cmpVal(a[k], b[k]) * dir);
}

function updateSortIndicators() {
  for (const th of document.querySelectorAll('#head th')) {
    const arrow = th.querySelector('.arrow');
    if (arrow) arrow.remove();
    if (th.dataset.key === sortKey) {
      const span = document.createElement('span');
      span.className = 'arrow';
      span.textContent = sortDir === 1 ? '▲' : '▼';
      th.appendChild(span);
    }
  }
}

function render(snapshot) {
  lastSnapshot = snapshot;
  const runStartMs = Date.parse(snapshot.startedAt);
  document.getElementById('startedAt').textContent = new Date(snapshot.startedAt).toLocaleString();
  const el = snapshot.elapsedSec;
  document.getElementById('elapsed').textContent =
    el >= 60 ? Math.floor(el / 60) + 'm ' + (el % 60) + 's' : el + 's';
  document.getElementById('cmd').textContent = snapshot.commandLine;
  const c = snapshot.counts;
  document.getElementById('c-passed').textContent = c.passed;
  document.getElementById('c-failed').textContent = c.failed;
  document.getElementById('c-skipped').textContent = c.skipped;
  document.getElementById('c-restored').textContent = c.restored;
  document.getElementById('c-running').textContent = c.running;
  document.getElementById('c-pending').textContent = c.pending;
  document.getElementById('c-total').textContent = snapshot.totalPlanned;

  const tbody = document.getElementById('rows');
  tbody.replaceChildren();
  for (const s of sortedScenarios(snapshot.scenarios)) {
    const tr = document.createElement('tr');
    // data-status drives the per-status filter checkboxes (badges in the
    // header). CSS hides matching rows when the table has hide-STATUS.
    tr.dataset.status = s.status;
    const appTd = document.createElement('td'); appTd.textContent = s.app; tr.appendChild(appTd);
    const scTd = document.createElement('td');
    const a = document.createElement('a');
    a.href = s.indexPath;
    a.textContent = s.variant || s.id;
    scTd.appendChild(a);
    tr.appendChild(scTd);
    for (const flag of [s.ssl, s.oidc, s.mtls]) {
      const td = document.createElement('td');
      td.className = 'center';
      td.textContent = flag ? '✓' : '—';
      tr.appendChild(td);
    }
    const stTd = document.createElement('td'); stTd.textContent = s.storage || '—'; tr.appendChild(stTd);
    const statusTd = document.createElement('td'); statusTd.appendChild(badge(s.status)); tr.appendChild(statusTd);
    const startTd = document.createElement('td'); startTd.className = 'num center'; startTd.textContent = formatTime(s.startedAtMs, runStartMs); tr.appendChild(startTd);
    const endTd = document.createElement('td'); endTd.className = 'num center'; endTd.textContent = formatTime(s.finishedAtMs, runStartMs); tr.appendChild(endTd);
    // Tag the duration cell so the 1-second tick can refresh it without a
    // full re-render (matters for the many "running" rows in a parallel run).
    const durTd = document.createElement('td');
    durTd.className = 'num center duration-cell';
    durTd.dataset.status = s.status;
    if (s.startedAtMs != null) durTd.dataset.startedMs = String(s.startedAtMs);
    if (s.finishedAtMs != null) durTd.dataset.finishedMs = String(s.finishedAtMs);
    durTd.textContent = formatDurationFromCell(durTd);
    tr.appendChild(durTd);
    tbody.appendChild(tr);
  }
  updateSortIndicators();

  const errors = snapshot.scenarios.filter((s) => s.error);
  const box = document.getElementById('errorsBox');
  const list = document.getElementById('errorsList');
  if (errors.length === 0) {
    box.style.display = 'none';
  } else {
    box.style.display = '';
    list.replaceChildren();
    for (const s of errors) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = s.id;
      li.appendChild(strong);
      li.appendChild(document.createTextNode(': ' + s.error));
      list.appendChild(li);
    }
  }
}

// Status-badge filters: clicking a badge toggles a table.hide-STATUS
// class that CSS uses to display:none matching rows.
for (const badge of document.querySelectorAll('.meta .badge[data-filter]')) {
  badge.addEventListener('click', () => {
    const status = badge.dataset.filter;
    const tbl = document.querySelector('table');
    const cls = 'hide-' + status;
    const nowHidden = !tbl.classList.contains(cls);
    tbl.classList.toggle(cls, nowHidden);
    badge.classList.toggle('filtered-out', nowHidden);
  });
}

// 1-second tick: refreshes the run "Elapsed" counter + per-scenario
// duration for any "running" row. Skipped on file:// (post-mortem view
// — the data is frozen at the final snapshot, ticking would be a lie).
// Cheap — touches only the elapsed span and the running-row duration cells.
if (location.protocol !== 'file:') {
  setInterval(() => {
    if (lastSnapshot) {
      const el = Math.floor((Date.now() - Date.parse(lastSnapshot.startedAt)) / 1000);
      document.getElementById('elapsed').textContent =
        el >= 60 ? Math.floor(el / 60) + 'm ' + (el % 60) + 's' : el + 's';
    }
    for (const td of document.querySelectorAll('.duration-cell[data-status="running"]')) {
      td.textContent = formatDurationFromCell(td);
    }
  }, 1000);
}

// Click cycle per column: asc → desc → unsorted (planned order).
document.getElementById('head').addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const key = th.dataset.key;
  if (!key) return;
  if (sortKey !== key) { sortKey = key; sortDir = 1; }
  else if (sortDir === 1) { sortDir = -1; }
  else { sortKey = null; sortDir = 1; }
  if (lastSnapshot) render(lastSnapshot);
});

function setSource(text, cls) {
  const el = document.getElementById('source');
  el.textContent = text;
  el.className = 'source ' + (cls || '');
}

async function loadJsonOnce() {
  try {
    const r = await fetch('./run-overview.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    render(await r.json());
    setSource('(snapshot from run-overview.json)', 'disconnected');
  } catch (e) {
    setSource('(no data: ' + (e && e.message ? e.message : e) + ')', 'disconnected');
  }
}

if (location.protocol === 'file:' || !SSE_URL) {
  // Post-mortem view from the filesystem: read JSON once, no SSE.
  loadJsonOnce();
} else {
  setSource('(connecting…)');
  const es = new EventSource(SSE_URL);
  es.onmessage = (ev) => {
    try {
      const snapshot = JSON.parse(ev.data);
      render(snapshot);
      setSource('(live)', 'live');
    } catch (e) { /* ignore malformed frame */ }
  };
  es.onerror = () => {
    // EventSource auto-reconnects; surface state to the user and fall back to
    // the on-disk JSON so something is visible while we wait.
    setSource('(disconnected, showing last JSON snapshot)', 'disconnected');
    loadJsonOnce();
  };
}
</script>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
