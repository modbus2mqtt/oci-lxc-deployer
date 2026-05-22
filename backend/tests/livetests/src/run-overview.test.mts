import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildSnapshot,
  writeRunOverviewHtml,
  writeRunOverviewJson,
  type RunOverviewState,
  type ScenarioStatus,
} from "./run-overview.mjs";
import type { PlannedScenario } from "./livetest-types.mjs";

function planned(id: string, app: string, opts: { tags?: string[]; computedTags?: string[] } = {}): PlannedScenario {
  return {
    vmId: 200,
    hostname: `${app}-h`,
    stackName: id.split("/")[1] ?? id,
    scenario: {
      id,
      application: app,
      description: id,
      ...(opts.tags ? { tags: opts.tags } : {}),
      ...(opts.computedTags ? { computedTags: opts.computedTags } : {}),
    },
    hasStacktype: false,
    isDependency: false,
    skipExecution: false,
  };
}

function state(plannedScenarios: PlannedScenario[], outDir = "/tmp/none"): RunOverviewState {
  return {
    outDir,
    runId: "test-run-1",
    startedAt: new Date("2026-05-22T10:00:00Z"),
    commandLine: "node runner.mjs --foo",
    planned: plannedScenarios,
    status: new Map<string, ScenarioStatus>(),
    startedAtMap: new Map(),
    finishedAtMap: new Map(),
    storage: new Map(),
    errorMessages: new Map(),
  };
}

describe("buildSnapshot", () => {
  it("emits a planned scenario as pending with no duration", () => {
    const s = state([planned("nginx/default", "nginx")]);
    const snap = buildSnapshot(s, new Date("2026-05-22T10:00:30Z").getTime());
    expect(snap.totalPlanned).toBe(1);
    expect(snap.counts.pending).toBe(1);
    expect(snap.scenarios[0]).toMatchObject({
      id: "nginx/default",
      app: "nginx",
      variant: "default",
      status: "pending",
      durationSec: null,
      startedAtMs: null,
      finishedAtMs: null,
    });
    expect(snap.elapsedSec).toBe(30);
  });

  it("computes a running scenario's live duration from now-startedAt", () => {
    const s = state([planned("nginx/default", "nginx")]);
    const startedAt = new Date("2026-05-22T10:00:10Z");
    s.startedAtMap.set("nginx/default", startedAt);
    s.status.set("nginx/default", "running");
    const snap = buildSnapshot(s, new Date("2026-05-22T10:00:25Z").getTime());
    expect(snap.scenarios[0]?.status).toBe("running");
    expect(snap.scenarios[0]?.durationSec).toBe(15);
    expect(snap.counts.running).toBe(1);
  });

  it("computes a finished scenario's duration from finished-started", () => {
    const s = state([planned("nginx/default", "nginx")]);
    s.startedAtMap.set("nginx/default", new Date("2026-05-22T10:00:10Z"));
    s.finishedAtMap.set("nginx/default", new Date("2026-05-22T10:00:42Z"));
    s.status.set("nginx/default", "passed");
    const snap = buildSnapshot(s);
    expect(snap.scenarios[0]?.durationSec).toBe(32);
    expect(snap.scenarios[0]?.startedAtMs).toBe(Date.UTC(2026, 4, 22, 10, 0, 10));
    expect(snap.scenarios[0]?.finishedAtMs).toBe(Date.UTC(2026, 4, 22, 10, 0, 42));
    expect(snap.counts.passed).toBe(1);
    expect(snap.counts.pending).toBe(0);
  });

  it("detects features from variant + tags", () => {
    const s = state([
      planned("nginx/ssl", "nginx"),
      planned("postgrest/mtls", "postgrest"),
      planned("zitadel/default", "zitadel"),
      planned("foo/with-oidc-addon", "foo", { computedTags: ["addon:oidc"] }),
    ]);
    const snap = buildSnapshot(s);
    expect(snap.scenarios[0]).toMatchObject({ ssl: true, mtls: false, oidc: false });
    expect(snap.scenarios[1]).toMatchObject({ ssl: true, mtls: true });
    expect(snap.scenarios[2]?.oidc).toBe(true);
    expect(snap.scenarios[3]?.oidc).toBe(true);
  });

  it("counts mixed statuses and pending is total minus the rest", () => {
    const s = state([
      planned("a/x", "a"),
      planned("b/x", "b"),
      planned("c/x", "c"),
      planned("d/x", "d"),
    ]);
    s.status.set("a/x", "passed");
    s.status.set("b/x", "failed");
    s.status.set("c/x", "running");
    const snap = buildSnapshot(s);
    expect(snap.counts).toMatchObject({ passed: 1, failed: 1, running: 1, pending: 1 });
  });
});

describe("writeRunOverviewJson / writeRunOverviewHtml", () => {
  it("writes a parseable JSON snapshot and an HTML viewer with embedded constants", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "run-overview-test-"));
    try {
      const s = state([planned("nginx/ssl", "nginx")], dir);
      writeRunOverviewJson(s);
      const json = JSON.parse(readFileSync(path.join(dir, "run-overview.json"), "utf8"));
      expect(json.runId).toBe("test-run-1");
      expect(json.scenarios).toHaveLength(1);

      writeRunOverviewHtml(s, "http://localhost:8090/events/test-run-1");
      const html = readFileSync(path.join(dir, "run-overview.html"), "utf8");
      expect(html).toContain("const RUN_ID = \"test-run-1\";");
      expect(html).toContain("const SSE_URL = \"http://localhost:8090/events/test-run-1\";");
      expect(html).toContain("location.protocol === 'file:'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("encodes SSE_URL as null when the server didn't start", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "run-overview-test-"));
    try {
      const s = state([planned("nginx/ssl", "nginx")], dir);
      writeRunOverviewHtml(s, null);
      const html = readFileSync(path.join(dir, "run-overview.html"), "utf8");
      expect(html).toContain("const SSE_URL = null;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT write the old run-overview.md file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "run-overview-test-"));
    try {
      const s = state([planned("nginx/ssl", "nginx")], dir);
      writeRunOverviewJson(s);
      writeRunOverviewHtml(s, null);
      expect(existsSync(path.join(dir, "run-overview.md"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
