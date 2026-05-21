/**
 * Live-updated Markdown overview of the run.
 *
 * Writes `<outDir>/run-overview.md` (overwriting on each transition) so an
 * operator can `tail -F` or refresh the file in a Markdown viewer to track
 * the run in real time. Columns: app, scenario (linked to per-scenario
 * directory), SSL, OIDC, mTLS, assigned storage, status, duration.
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

function statusBadge(s: ScenarioStatus): string {
  switch (s) {
    case "pending": return "&#9203; pending";   // hourglass
    case "running": return "&#9654; running";   // play
    case "passed": return "&#10004; passed";    // check
    case "failed": return "&#10008; failed";    // x
    case "skipped": return "&#8856; skipped";   // circled dash
    case "restored": return "&#8634; restored"; // anticlockwise arrow
  }
}

export function renderRunOverview(state: RunOverviewState): string {
  const rows: string[] = [];
  for (const p of state.planned) {
    const sid = p.scenario.id;
    const [app, variant = ""] = sid.split("/");
    const f = detectFeatures(p);
    const status = state.status.get(sid) ?? "pending";
    const start = state.startedAtMap.get(sid);
    const end = state.finishedAtMap.get(sid);
    let dur = "";
    if (start && end) {
      dur = `${((end.getTime() - start.getTime()) / 1000).toFixed(1)}s`;
    } else if (start && (status === "running")) {
      dur = `${((Date.now() - start.getTime()) / 1000).toFixed(0)}s …`;
    }
    const storage = state.storage.get(sid) ?? "";
    const slug = sanitizeScenarioId(sid);
    const variantLink = `[${variant || sid}](${slug}/livetest-index.md)`;
    rows.push(`| ${app} | ${variantLink} | ${f.ssl ? "✓" : "—"} | ${f.oidc ? "✓" : "—"} | ${f.mtls ? "✓" : "—"} | ${storage || "—"} | ${statusBadge(status)} | ${dur} |`);
  }

  let passed = 0, failed = 0, skipped = 0, restored = 0, running = 0, pending = 0;
  for (const s of state.status.values()) {
    if (s === "passed") passed++;
    else if (s === "failed") failed++;
    else if (s === "skipped") skipped++;
    else if (s === "restored") restored++;
    else if (s === "running") running++;
    else pending++;
  }
  // status map only carries entries for scenarios that have transitioned; the
  // remainder count as pending.
  pending = state.planned.length - passed - failed - skipped - restored - running;

  const elapsedSec = Math.floor((Date.now() - state.startedAt.getTime()) / 1000);
  const elapsed = elapsedSec >= 60
    ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
    : `${elapsedSec}s`;

  const errorLines: string[] = [];
  for (const p of state.planned) {
    const err = state.errorMessages.get(p.scenario.id);
    if (err) errorLines.push(`- **${p.scenario.id}**: ${err}`);
  }

  return `# Livetest Run Overview

**Run ID**: \`${state.runId}\`
**Started**: ${state.startedAt.toISOString()} · **Elapsed**: ${elapsed}
**Status**: ✓ ${passed} passed · ✗ ${failed} failed · ⊘ ${skipped} skipped · ↺ ${restored} restored · ▶ ${running} running · ⏳ ${pending} pending (of ${state.planned.length})

**Command**:
\`\`\`
${state.commandLine}
\`\`\`

| App | Scenario | SSL | OIDC | mTLS | Storage | Status | Duration |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}
${errorLines.length > 0 ? `\n## Errors\n${errorLines.join("\n")}\n` : ""}`;
}

export function writeRunOverview(state: RunOverviewState): void {
  try {
    writeFileSync(path.join(state.outDir, "run-overview.md"), renderRunOverview(state));
  } catch { /* best-effort */ }
}
