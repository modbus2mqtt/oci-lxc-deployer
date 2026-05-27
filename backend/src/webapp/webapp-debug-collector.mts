import type { LogLevel } from "../logger/index.mjs";
import type { IVarSubstitution } from "../variable-resolver.mjs";
import type { IVeDebugEvent } from "../ve-execution/ve-execution-message-emitter.mjs";

const RETENTION_MS = 30 * 60 * 1000; // 30 min, matches WebAppVeMessageManager

export type DebugLevel = "off" | "extLog" | "script";

type TraceEvent =
  | {
      ts: number;
      source: "logger";
      level: LogLevel;
      component: string;
      msg: string;
      meta?: Record<string, unknown>;
    }
  | { ts: number; source: "stderr"; line: string }
  | {
      ts: number;
      source: "applog";
      channel: "lxc" | "docker";
      vmId: number;
      line: string;
    }
  | {
      ts: number;
      source: "runner";
      level: "info" | "ok" | "warn" | "fail" | "step" | "debug";
      msg: string;
    }
  | {
      ts: number;
      source: "substitution";
      varName: string;
      redactedValue: string;
      line: number;
      secure: boolean;
    };

interface DebugScript {
  index: number;
  command: string;
  executeOn: string | undefined;
  template?: string;
  startedAt: number;
  finishedAt?: number;
  exitCode?: number;
  redactedScript: string;
  substitutions: IVarSubstitution[];
  skipped?: boolean;
  skippedReason?: string;
}

interface DebugDiagnostic {
  vmId: number;
  label: string; // e.g. "current", "previous"
  conf?: string;
  confError?: string;
}

interface DebugEntry {
  application: string;
  task: string;
  restartKey: string;
  debugLevel: DebugLevel;
  startedAt: number;
  finishedAt?: number;
  scripts: DebugScript[];
  events: TraceEvent[];
  diagnostics: DebugDiagnostic[];
  // Promise that resolves when finish() is called. Lets bundle consumers
  // (test runner) await async post-task capture (LXC log + conf) before
  // they read the manifest — otherwise they race and miss diagnostics/.
  ready: Promise<void>;
  resolveReady: () => void;
}

/**
 * Collects per-task debug information (logger lines, redacted scripts,
 * variable substitutions, script stderr) and renders them as a linked
 * Markdown bundle. RAM-only, expires after 30 minutes.
 *
 * Wiring overview:
 *   - `start()` is called by the route handler at task start with the
 *     restartKey + selected debugLevel.
 *   - `attachStderr()` is fed from the MessageManager listener when a
 *     partial message arrives.
 *   - `attachScriptStart()` / `attachScriptEnd()` are fed from the VeExecution
 *     `"debug"` channel — each event carries its own restartKey (stamped on
 *     ICommand at task start, threaded by MessageEmitter), so the
 *     dispatcher can run multiple tasks concurrently without interleaving.
 *   - `finish()` marks the entry complete (timestamp).
 *   - `renderBundle()` returns the virtual file map.
 */
/**
 * Module-level reference set by WebAppVE on construction so that
 * services running outside the webapp (clone-cleanup-service, etc.) can
 * reach the live collector. The lifetime matches the webapp's, so it's
 * safe to keep a global pointer. Returns null before WebAppVE.init runs.
 */
let activeCollector: WebAppDebugCollector | null = null;
export function getActiveDebugCollector(): WebAppDebugCollector | null {
  return activeCollector;
}

export class WebAppDebugCollector {
  private entries: Map<string, DebugEntry> = new Map();
  /** Tracks which restartKey is currently active for the logger sink. */
  private activeRestartKey: string | null = null;
  /**
   * Pre-rendered bundles adopted from another deployer (clone) — keyed by
   * the same restartKey the clone used. After a self-upgrade-via-clone the
   * new deployer pulls the clone's bundle and injects it here so that
   * `GET /api/ve/debug/<restartKey>/*` keeps working on the new deployer
   * as if it had run the task itself.
   *
   * Stored as a virtual file map (filename → content), the same shape
   * `renderBundle()` produces, so the route handlers can serve adopted
   * bundles uniformly with live ones.
   */
  private adoptedBundles: Map<string, Map<string, string>> = new Map();

  constructor() {
    activeCollector = this;
  }

  /** Returns the currently active restartKey (logger sink uses this). */
  getActiveRestartKey(): string | null {
    return this.activeRestartKey;
  }

  start(
    restartKey: string,
    application: string,
    task: string,
    debugLevel: DebugLevel,
  ): void {
    if (debugLevel === "off") return;
    const now = Date.now();
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.entries.set(restartKey, {
      application,
      task,
      restartKey,
      debugLevel,
      startedAt: now,
      scripts: [],
      events: [],
      diagnostics: [],
      ready,
      resolveReady,
    });
  }

  finish(restartKey: string): void {
    const entry = this.entries.get(restartKey);
    if (!entry) return;
    entry.finishedAt = Date.now();
    entry.resolveReady();
  }

  /**
   * Resolves when finish() has been called for this restartKey, or
   * immediately when there is no entry (debug was off / already expired).
   * Bundle consumers (test runners) await this before reading the manifest
   * so they don't race with async post-task diagnostic capture.
   */
  // 90s ceiling: the slowest observed post-install-crash path takes ~91s
  // between the host-side runner declaring failure (via wait_seconds) and
  // the backend's finalizeBundle firing — the backend may still be mid-
  // install when the runner gives up, then runs captureLxcDiagnostics on
  // a stopped CT. 30s was cutting that case short, leaving the bundle
  // empty even though it would have been complete moments later.
  async waitForFinish(restartKey: string, timeoutMs = 90000): Promise<void> {
    const entry = this.entries.get(restartKey);
    if (!entry) return;
    if (entry.finishedAt !== undefined) return;
    await Promise.race([
      entry.ready,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  has(restartKey: string): boolean {
    return this.entries.has(restartKey);
  }

  /**
   * Attach an externally-sourced event from the livetest runner. The runner
   * (`live-test-runner.mts` and its helpers in `log-helpers.mts`) holds
   * per-scenario context that the deployer never sees — preFlight / verify /
   * snapshot / janitor / Playwright / cleanup events. Posting them into the
   * collector via `POST /api/debug/external-events` lets the unified bundle
   * timeline interleave runner + backend events for diagnosis. Events
   * arriving after `finish()` are appended to the in-memory entry; whether
   * they make it into the rendered bundle depends on render timing — the
   * runner posts them BEFORE downloading the bundle, so they normally do.
   */
  attachRunnerEvent(
    restartKey: string,
    event: {
      ts: number;
      level: "info" | "ok" | "warn" | "fail" | "step" | "debug";
      msg: string;
    },
  ): void {
    const e = this.entries.get(restartKey);
    if (!e) return;
    e.events.push({
      ts: event.ts,
      source: "runner",
      level: event.level,
      msg: event.msg,
    });
  }

  attachStderr(restartKey: string, line: string): void {
    const e = this.entries.get(restartKey);
    if (!e) return;
    // Split multi-line stderr chunks; each line becomes its own event so
    // they interleave cleanly with logger lines.
    const parts = line.split("\n");
    for (const p of parts) {
      if (p.length === 0) continue;
      e.events.push({ ts: Date.now(), source: "stderr", line: p });
    }
  }

  /**
   * Attach a live application-log line (LXC console log or docker-compose
   * service log) captured by the AppLogMonitor while the task runs. Fed
   * line-by-line; each line becomes its own timestamped trace event so it
   * interleaves with logger/stderr lines via bucketEvents(). ts is the
   * backend read time (Date.now()) — cache/clock skew is accepted by design.
   */
  attachAppLog(
    restartKey: string,
    channel: "lxc" | "docker",
    vmId: number,
    line: string,
  ): void {
    const e = this.entries.get(restartKey);
    if (!e) return;
    const parts = line.split("\n");
    for (const p of parts) {
      // `docker compose logs` prefixes lines with cursor-control escapes
      // (e.g. ESC[2K) even with --no-color, which would hide the leading
      // "<service>-1 |" prefix. Strip ANSI/CSI so the originating docker
      // service stays immediately recognizable in the trace.
      const clean = stripAnsi(p).replace(/\r$/, "").replace(/^\s+/, "");
      if (clean.length === 0) continue;
      e.events.push({
        ts: Date.now(),
        source: "applog",
        channel,
        vmId,
        line: clean,
      });
    }
  }

  /**
   * Attach captured per-VM diagnostics: the LXC config file. Called once per
   * VM-of-interest after the task finishes. The conf is embedded inline in
   * `index.md`. (The LXC console log is no longer captured here — it streams
   * live into the timeline via the AppLogMonitor.)
   */
  attachDiagnostic(restartKey: string, diag: DebugDiagnostic): void {
    const e = this.entries.get(restartKey);
    if (!e) return;
    e.diagnostics.push(diag);
  }

  handleDebugEvent(restartKey: string, event: IVeDebugEvent): void {
    const e = this.entries.get(restartKey);
    if (!e) return;
    if (event.type === "script-start") {
      e.scripts.push({
        index: event.index,
        command: event.command,
        executeOn: event.executeOn,
        ...(event.template ? { template: event.template } : {}),
        startedAt: event.ts,
        redactedScript: event.redactedScript,
        substitutions: event.substitutions,
      });
      // Also record substitution events so they appear in the trace.
      for (const s of event.substitutions) {
        e.events.push({
          ts: event.ts,
          source: "substitution",
          varName: s.var,
          redactedValue: s.redactedValue,
          line: s.line,
          secure: s.secure,
        });
      }
    } else if (event.type === "script-skipped") {
      // A command whose skip_if_all_missing condition matched. Recorded as
      // its own row in the chronological scripts table (no per-script .md
      // file is written for skipped entries — there's no body to redact and
      // no trace to interleave).
      e.scripts.push({
        index: event.index,
        command: event.command,
        executeOn: event.executeOn,
        ...(event.template ? { template: event.template } : {}),
        startedAt: event.ts,
        finishedAt: event.ts,
        redactedScript: "",
        substitutions: [],
        skipped: true,
        skippedReason: event.reason,
      });
    } else {
      const script = e.scripts.find((s) => s.index === event.index);
      if (script) {
        script.finishedAt = event.ts;
        script.exitCode = event.exitCode;
      }
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries.entries()) {
      const ref = entry.finishedAt ?? entry.startedAt;
      if (now - ref > RETENTION_MS) this.entries.delete(key);
    }
  }

  /**
   * Render the bundle for `restartKey` as a virtual file map. Returns null
   * when the entry does not exist (debug was off or expired).
   *
   * The bundle uses two file types:
   *   - `.md`   — for humans. Tables, prose, the redacted script body, the
   *               chronological text trace. Linked together.
   *   - `.json` — for machines. Sidecar files alongside each .md hold the
   *               raw event records (header, substitutions, trace events,
   *               variable cross-reference). The .md links to them; humans
   *               don't need to read them.
   */
  /**
   * Inject a pre-rendered bundle that this deployer adopts from another
   * source (e.g. a clone-driven self-upgrade). Subsequent
   * `renderBundle(restartKey)` calls return this file map directly,
   * bypassing the live entries map.
   *
   * Idempotent: subsequent injects under the same key replace the previous
   * bundle (useful for retries).
   */
  injectBundle(restartKey: string, files: Map<string, string>): void {
    this.adoptedBundles.set(restartKey, files);
  }

  /**
   * Whether a bundle (live or adopted) exists for the given key. Used by
   * the route handlers to short-circuit `waitForFinish` for adopted
   * bundles (which never had a live entry, so the wait would always
   * return immediately anyway, but checking upfront is cheaper).
   */
  hasAdoptedBundle(restartKey: string): boolean {
    return this.adoptedBundles.has(restartKey);
  }

  renderBundle(restartKey: string): Map<string, string> | null {
    const adopted = this.adoptedBundles.get(restartKey);
    if (adopted) return adopted;
    const entry = this.entries.get(restartKey);
    if (!entry) return null;
    const files = new Map<string, string>();

    // Sort scripts by index for deterministic output
    entry.scripts.sort((a, b) => a.index - b.index);
    const sortedEvents = [...entry.events].sort((a, b) => a.ts - b.ts);

    const buckets = this.bucketEvents(entry, sortedEvents);

    const { md: indexMd, json: headerJson } = this.renderIndex(entry, buckets);
    files.set("index.md", indexMd);
    files.set("header.json", headerJson);

    const { md: variablesMd, json: variablesJson } = this.renderVariables(entry);
    files.set("variables.md", variablesMd);
    files.set("variables.json", variablesJson);

    for (const script of entry.scripts) {
      // Skipped commands have no body and no trace — they're represented
      // only by their row in the index.md scripts table. Writing per-script
      // .md/.json sidecars would be empty noise.
      if (script.skipped) continue;
      const slug = slugify(script.command, script.index);
      const base = `${pad2(script.index)}-${slug}`;
      const scriptFiles = this.renderScript(
        script,
        buckets.scripts.get(script.index) ?? [],
        buckets.postTraces.get(script.index) ?? [],
        base,
      );
      files.set(`scripts/${base}.md`, scriptFiles.md);
      files.set(`scripts/${base}.meta.json`, scriptFiles.metaJson);
      files.set(`scripts/${base}.substitutions.json`, scriptFiles.substJson);
      files.set(`scripts/${base}.trace.json`, scriptFiles.traceJson);
    }

    // Captured diagnostics: only the (small) /etc/pve/lxc/<vmid>.conf is kept,
    // embedded inline in index.md. The LXC console log is no longer captured
    // post-hoc — it streams live into the timeline via the AppLogMonitor.

    return files;
  }

  /**
   * Distribute trace events into preamble / per-script / post-trace /
   * postamble buckets based on the script start/end timestamps.
   */
  private bucketEvents(
    entry: DebugEntry,
    events: TraceEvent[],
  ): {
    preamble: TraceEvent[];
    postamble: TraceEvent[];
    scripts: Map<number, TraceEvent[]>;
    postTraces: Map<number, TraceEvent[]>;
  } {
    const preamble: TraceEvent[] = [];
    const postamble: TraceEvent[] = [];
    const scripts = new Map<number, TraceEvent[]>();
    const postTraces = new Map<number, TraceEvent[]>();

    if (entry.scripts.length === 0) {
      preamble.push(...events);
      return { preamble, postamble, scripts, postTraces };
    }

    const firstStart = entry.scripts[0]!.startedAt;
    const lastEnd =
      entry.scripts[entry.scripts.length - 1]!.finishedAt ?? Number.MAX_VALUE;

    for (const ev of events) {
      if (ev.ts < firstStart) {
        preamble.push(ev);
        continue;
      }
      if (ev.ts > lastEnd) {
        postamble.push(ev);
        continue;
      }
      // Find script containing this timestamp
      let assignedToScript = false;
      for (const s of entry.scripts) {
        const end = s.finishedAt ?? Number.MAX_VALUE;
        if (ev.ts >= s.startedAt && ev.ts <= end) {
          let arr = scripts.get(s.index);
          if (!arr) {
            arr = [];
            scripts.set(s.index, arr);
          }
          arr.push(ev);
          assignedToScript = true;
          break;
        }
      }
      if (assignedToScript) continue;
      // Event sits in a gap between two scripts → attach to the preceding one
      let precedingIdx = -1;
      for (const s of entry.scripts) {
        if ((s.finishedAt ?? 0) <= ev.ts) precedingIdx = s.index;
        else break;
      }
      if (precedingIdx >= 0) {
        let arr = postTraces.get(precedingIdx);
        if (!arr) {
          arr = [];
          postTraces.set(precedingIdx, arr);
        }
        arr.push(ev);
      } else {
        preamble.push(ev);
      }
    }
    return { preamble, postamble, scripts, postTraces };
  }

  private renderIndex(
    entry: DebugEntry,
    buckets: ReturnType<WebAppDebugCollector["bucketEvents"]>,
  ): { md: string; json: string } {
    const duration =
      entry.finishedAt !== undefined ? entry.finishedAt - entry.startedAt : 0;
    const header = {
      application: entry.application,
      task: entry.task,
      restartKey: entry.restartKey,
      debugLevel: entry.debugLevel,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt ?? null,
      durationMs: duration,
      scriptCount: entry.scripts.length,
    };

    const scriptRows = entry.scripts.map((s) => {
      if (s.skipped) {
        return `| ${s.index} | \`${escapeMd(s.command)}\` | ${s.executeOn ?? "—"} | skipped | — | _${escapeMd(s.skippedReason ?? "skipped")}_ |`;
      }
      const slug = slugify(s.command, s.index);
      const exit = s.exitCode ?? "?";
      const dur =
        s.finishedAt !== undefined ? `${s.finishedAt - s.startedAt}ms` : "?";
      return `| ${s.index} | \`${escapeMd(s.command)}\` | ${s.executeOn ?? "?"} | ${exit} | ${dur} | [scripts/${pad2(s.index)}-${slug}.md](scripts/${pad2(s.index)}-${slug}.md) |`;
    });

    const hasDiagnostics = entry.diagnostics.length > 0;
    const md = [
      `# Debug Bundle — ${entry.application} ${entry.task}`,
      `**restartKey**: \`${entry.restartKey}\` · **level**: \`${entry.debugLevel}\` · **duration**: ${duration}ms`,
      ``,
      traceStyleBlock(),
      ``,
      `Machine-readable header: [header.json](header.json)`,
      ``,
      `## Contents`,
      `- [Scripts (chronological)](#scripts-chronological)`,
      `- [Preamble Trace](#preamble-trace)`,
      `- [Postamble Trace](#postamble-trace)`,
      ...(hasDiagnostics ? [`- [Diagnostics](#diagnostics)`] : []),
      `- [Cross-References](#cross-references)`,
      ``,
      section("Scripts (chronological)"),
      `| # | Command | execute_on | exit | duration | Link |`,
      `|--:|---|---|---:|---:|---|`,
      ...scriptRows,
      ``,
      section("Preamble Trace"),
      `_Events before the first script (backend setup, parameter resolve)._`,
      renderTraceHtml(buckets.preamble),
      ``,
      section("Postamble Trace"),
      `_Events after the last script (cleanup, notes update)._`,
      renderTraceHtml(buckets.postamble),
      ``,
      ...(hasDiagnostics ? renderDiagnostics(entry.diagnostics) : []),
      section("Cross-References"),
      `- [Variables](variables.md) — where each variable is used`,
      ``,
    ].join("\n");

    return { md, json: JSON.stringify(header, null, 2) };
  }

  private renderVariables(entry: DebugEntry): { md: string; json: string } {
    // Aggregate substitutions across scripts: var → [{script, line, secure}]
    type Use = { script: number; line: number; secure: boolean };
    const byVar = new Map<string, Use[]>();
    for (const s of entry.scripts) {
      for (const sub of s.substitutions) {
        let arr = byVar.get(sub.var);
        if (!arr) {
          arr = [];
          byVar.set(sub.var, arr);
        }
        arr.push({ script: s.index, line: sub.line, secure: sub.secure });
      }
    }
    const sortedVars = [...byVar.keys()].sort();
    const sections: string[] = [
      `# Variable Cross-Reference`,
      ``,
      `Machine-readable map: [variables.json](variables.json)`,
      ``,
    ];

    // Variable TOC — clickable links to each variable's own section.
    if (sortedVars.length > 0) {
      sections.push(`## Contents`);
      for (const v of sortedVars) {
        const isSecure = byVar.get(v)!.some((u) => u.secure);
        sections.push(
          `- [${v}${isSecure ? " (secure)" : ""}](#${anchorSlug(v)})`,
        );
      }
      sections.push(``);
    }

    for (const v of sortedVars) {
      const uses = byVar.get(v)!;
      const isSecure = uses.some((u) => u.secure);
      const title = isSecure ? `${v} _(secure)_` : v;
      // Anchor uses the bare variable name so it stays stable regardless of
      // the secure-flag marker we add for humans.
      sections.push(section(title, anchorSlug(v)));
      for (const u of uses) {
        const script = entry.scripts.find((s) => s.index === u.script);
        if (!script) continue;
        const slug = slugify(script.command, script.index);
        sections.push(
          `- [scripts/${pad2(u.script)}-${slug}.md](scripts/${pad2(u.script)}-${slug}.md) — script ${u.script}, line ${u.line}`,
        );
      }
      sections.push(``);
    }

    const machine: Record<string, Use[]> = {};
    for (const [v, uses] of byVar.entries()) machine[v] = uses;

    return { md: sections.join("\n"), json: JSON.stringify(machine, null, 2) };
  }

  private renderScript(
    script: DebugScript,
    traceEvents: TraceEvent[],
    postTraceEvents: TraceEvent[],
    base: string,
  ): { md: string; metaJson: string; substJson: string; traceJson: string } {
    const duration =
      script.finishedAt !== undefined
        ? script.finishedAt - script.startedAt
        : 0;
    const meta = {
      index: script.index,
      command: script.command,
      executeOn: script.executeOn ?? null,
      template: script.template ?? null,
      exitCode: script.exitCode ?? null,
      startedAt: script.startedAt,
      finishedAt: script.finishedAt ?? null,
      durationMs: duration,
    };
    const substMeta = script.substitutions.map((s) => ({
      var: s.var,
      redactedValue: s.redactedValue,
      line: s.line,
      secure: s.secure,
    }));

    const lang = script.redactedScript.startsWith("#!")
      ? script.redactedScript.includes("python")
        ? "python"
        : "sh"
      : "text";

    // When the command processor merged libraries (global VE lib + template
    // library) before the script body, the marker line separates them. We
    // detect it and show only the script body — the libraries dominate the
    // file length (~50-200 lines each) and rarely change between runs.
    // The body's 1-based line number in the merged content is surfaced so
    // `set -x` line refs in the trace below stay decodable.
    const layout = splitScriptFromLibraries(script.redactedScript);
    const scriptBody = layout ? layout.body : script.redactedScript;
    const layoutInfo = layout
      ? `_Merged-content layout: libraries occupy lines 1–${layout.libraryEndLine} (${layout.libraryEndLine} lines, hidden). Script body starts at line ${layout.bodyStartLine} — use this offset when reading \`set -x\` line refs in the trace._`
      : "";

    const machineTrace = traceEvents.map((e) => {
      if (e.source === "logger") {
        return {
          ts: e.ts,
          source: "logger",
          level: e.level,
          component: e.component,
          msg: e.msg,
          ...(e.meta ? { meta: e.meta } : {}),
        };
      }
      if (e.source === "stderr")
        return { ts: e.ts, source: "stderr", line: e.line };
      if (e.source === "applog")
        return {
          ts: e.ts,
          source: "applog",
          channel: e.channel,
          vmId: e.vmId,
          line: e.line,
        };
      if (e.source === "runner")
        return { ts: e.ts, source: "runner", level: e.level, msg: e.msg };
      return {
        ts: e.ts,
        source: "substitution",
        var: e.varName,
        redactedValue: e.redactedValue,
        line: e.line,
        secure: e.secure,
      };
    });

    const md = [
      `# Script ${script.index}: \`${escapeMd(script.command)}\``,
      `**execute_on**: \`${script.executeOn ?? "?"}\` · **exit**: ${script.exitCode ?? "?"} · **duration**: ${duration}ms · [↩ index](../index.md)`,
      `**startedAt**: ${formatTime(script.startedAt)} · **finishedAt**: ${script.finishedAt !== undefined ? formatTime(script.finishedAt) : "?"}`,
      ``,
      traceStyleBlock(),
      ``,
      `Sidecars: [meta](${base}.meta.json) · [substitutions](${base}.substitutions.json) · [trace](${base}.trace.json)`,
      ``,
      `## Contents`,
      `- [Redacted Script](#redacted-script)`,
      `- [Trace (chronological)](#trace-chronological)`,
      `- [Post-Trace](#post-trace)`,
      ``,
      section("Redacted Script"),
      ...(layoutInfo ? [layoutInfo, ``] : []),
      "```" + lang,
      scriptBody,
      "```",
      ``,
      section("Trace (chronological)"),
      `_Backend logger lines and script stderr interleaved by timestamp._`,
      renderTraceHtml(traceEvents),
      ``,
      section("Post-Trace"),
      `_Events between the end of this script and the start of the next (if any)._`,
      renderTraceHtml(postTraceEvents),
      ``,
    ].join("\n");

    return {
      md,
      metaJson: JSON.stringify(meta, null, 2),
      substJson: JSON.stringify(substMeta, null, 2),
      traceJson: JSON.stringify(machineTrace, null, 2),
    };
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function slugify(name: string, fallbackIdx: number): string {
  if (!name || !name.trim()) return `script-${fallbackIdx}`;
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `script-${fallbackIdx}`;
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/**
 * Split a merged script (libraries prepended to body via the command
 * processor) into its layout pieces, so the debug-bundle Markdown can
 * show just the body and surface the line offset for `set -x` trace
 * references.
 *
 * The command processor's layout (see ve-execution-command-processor.mts
 * `loadCommandContent`):
 *
 *     <globalLib?>\n\n<templateLib?>\n\n# --- Script starts here ---\n<body>
 *
 * Or for `command:` (no scriptContent):
 *
 *     <globalLib?>\n\n<templateLib?>\n\n# --- Command starts here ---\n<body>
 *
 * Returns null when neither marker is present (e.g. no libraries were
 * prepended, or the merged-content format changed). Callers should fall
 * back to rendering the full `redactedScript`.
 */
function splitScriptFromLibraries(merged: string): {
  body: string;
  /** 1-based line number of the last library line (everything 1..N is hidden). */
  libraryEndLine: number;
  /** 1-based line number where the script body begins in the merged content. */
  bodyStartLine: number;
} | null {
  const MARKERS = [
    "# --- Script starts here ---",
    "# --- Command starts here ---",
  ];
  for (const marker of MARKERS) {
    const idx = merged.indexOf(marker);
    if (idx < 0) continue;
    // Count complete lines from the start up to and including the marker
    // line's trailing newline. `linesUpToMarker` = number of \n in that
    // slice, which equals the 1-based line number of the marker line.
    const markerEnd = idx + marker.length;
    const upTo = merged.slice(0, markerEnd + 1); // include the \n after the marker
    const linesUpToMarker = (upTo.match(/\n/g) ?? []).length;
    // libraryEndLine = marker line - 1 - 1 (subtract marker + the blank
    // separator immediately before it). Clamp at 0 in case the merged form
    // has no library content at all (shouldn't happen — marker is only
    // inserted when libraries are present).
    const libraryEndLine = Math.max(0, linesUpToMarker - 2);
    const bodyStartLine = linesUpToMarker + 1;
    const restAfterMarker = merged.slice(markerEnd);
    const body = restAfterMarker.startsWith("\n")
      ? restAfterMarker.slice(1)
      : restAfterMarker;
    return { body, libraryEndLine, bodyStartLine };
  }
  return null;
}

/**
 * Produce a stable anchor slug for in-document links. We emit explicit
 * `<a id="…"></a>` tags rather than relying on the renderer's auto-anchor
 * heuristics (which differ between GitHub, VS Code, and markserv).
 */
function anchorSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Emit an explicit anchor immediately followed by an `##` header. The empty
 * `<a id="…"></a>` is rendered as a no-op by every Markdown viewer but gives
 * us a deterministic jump target.
 */
function section(title: string, anchor?: string): string {
  const slug = anchor ?? anchorSlug(title);
  return `<a id="${slug}"></a>\n## ${title}`;
}

/**
 * Render the captured-diagnostics section: embed the (small)
 * /etc/pve/lxc/<vmid>.conf inline as a fenced code block. (The LXC console
 * log lives in the live timeline now, not here.)
 */
function renderDiagnostics(diagnostics: DebugDiagnostic[]): string[] {
  const lines: string[] = [section("Diagnostics")];
  for (const d of diagnostics) {
    lines.push(``, `### CT ${d.vmId} (${d.label})`);
    if (typeof d.conf === "string" && d.conf.length > 0) {
      lines.push(``, `**/etc/pve/lxc/${d.vmId}.conf:**`, "```", d.conf.trimEnd(), "```");
    } else if (d.confError) {
      lines.push(`- LXC config: _unavailable — ${d.confError}_`);
    }
  }
  lines.push(``);
  return lines;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toISOString().slice(11, 23); // HH:MM:SS.mmm
}

// Strip ANSI/CSI/OSC escape sequences (colour, cursor-control like ESC[2K,
// title sets). Keeps the visible text so log lines stay grep-/read-able.
 
const ANSI_RE = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)|[@-_]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One-time-per-document `<style>` block. Wraps a `.trace-block` so toggle
 * checkboxes affect only their sibling `.trace`. Uses `:has()` for scoped
 * filtering — supported by every modern Markdown renderer (VS Code, GitHub,
 * markserv) since 2022.
 */
function traceStyleBlock(): string {
  return [
    "<style>",
    "  .trace-block { margin: 0.5em 0 1.5em 0; }",
    "  .trace-block .filters { margin: 0.25em 0; font-family: sans-serif; font-size: 0.9em; }",
    "  .trace-block .filters label { margin-right: 1em; cursor: pointer; user-select: none; }",
    "  .trace { font-family: monospace; font-size: 0.85em; line-height: 1.35; white-space: pre-wrap; word-break: break-word; }",
    "  .trace .tr { display: block; padding: 1px 0; }",
    "  .trace .ts { color: #888; margin-right: 0.5em; }",
    "  .trace .tag { color: #06b; margin-right: 0.5em; }",
    "  .trace .component { color: #666; margin-right: 0.5em; }",
    "  .trace .msg { color: inherit; }",
    "  .trace .tr.source-stderr .tag { color: #888; }",
    "  .trace .tr.source-applog .tag { color: #093; }",
    "  .trace .tr.source-applog.channel-docker .tag { color: #2563eb; }",
    "  .trace .tr.source-subst .tag { color: #a60; }",
    "  .trace .tr.level-debug { color: #888; }",
    "  .trace .tr.level-warn .msg { color: #c80; }",
    "  .trace .tr.level-error .msg { color: #c00; font-weight: bold; }",
    "  /* Toggle rules — scoped to the containing .trace-block via :has() */",
    "  .trace-block:has(.filter-logger:not(:checked)) .tr.source-logger { display: none; }",
    "  .trace-block:has(.filter-stderr:not(:checked)) .tr.source-stderr { display: none; }",
    "  .trace-block:has(.filter-applog-lxc:not(:checked))    .tr.source-applog.channel-lxc    { display: none; }",
    "  .trace-block:has(.filter-applog-docker:not(:checked)) .tr.source-applog.channel-docker { display: none; }",
    "  .trace-block:has(.filter-subst:not(:checked))  .tr.source-subst  { display: none; }",
    "  .trace-block:has(.filter-debug:not(:checked))  .tr.level-debug   { display: none; }",
    "  .trace-block:has(.filter-info:not(:checked))   .tr.level-info    { display: none; }",
    "  .trace-block:has(.filter-warn:not(:checked))   .tr.level-warn    { display: none; }",
    "  .trace-block:has(.filter-error:not(:checked))  .tr.level-error   { display: none; }",
    "</style>",
  ].join("\n");
}

/**
 * Render a trace section as semantic HTML with per-source/level CSS classes
 * and a sibling filter-checkbox bar. Toggling a checkbox hides matching
 * rows via the `:has()` rules defined in `traceStyleBlock()`.
 *
 * Empty traces render as a single muted line — no checkboxes needed.
 */
function renderTraceHtml(events: TraceEvent[]): string {
  if (events.length === 0) {
    return `<div class="trace-block"><div class="trace empty"><em>(no events)</em></div></div>`;
  }

  // Collect which categories are present so we only show relevant filters.
  const present = {
    logger: false,
    stderr: false,
    subst: false,
    applogLxc: false,
    applogDocker: false,
    runner: false,
    debug: false,
    info: false,
    warn: false,
    error: false,
  };
  for (const e of events) {
    if (e.source === "logger") {
      present.logger = true;
      present[e.level as "debug" | "info" | "warn" | "error"] = true;
    } else if (e.source === "stderr") present.stderr = true;
    else if (e.source === "applog") {
      if (e.channel === "lxc") present.applogLxc = true;
      else present.applogDocker = true;
    } else if (e.source === "substitution") present.subst = true;
    else if (e.source === "runner") present.runner = true;
  }

  const filters: string[] = [];
  const filter = (cls: string, label: string) =>
    `<label><input type="checkbox" class="${cls}" checked /> ${label}</label>`;
  if (present.runner) filters.push(filter("filter-runner", "Runner"));
  if (present.logger) filters.push(filter("filter-logger", "Logger"));
  if (present.stderr) filters.push(filter("filter-stderr", "Stderr"));
  if (present.applogLxc)
    filters.push(filter("filter-applog-lxc", "App Log (LXC)"));
  if (present.applogDocker)
    filters.push(filter("filter-applog-docker", "App Log (Docker)"));
  if (present.subst) filters.push(filter("filter-subst", "Substitutions"));
  // Level toggles only meaningful when there's logger output
  if (present.logger) {
    if (present.debug) filters.push(filter("filter-debug", "debug"));
    if (present.info) filters.push(filter("filter-info", "info"));
    if (present.warn) filters.push(filter("filter-warn", "warn"));
    if (present.error) filters.push(filter("filter-error", "error"));
  }

  const rows = events.map((e) => {
    const t = formatTime(e.ts);
    if (e.source === "logger") {
      return `<div class="tr source-logger level-${e.level}"><span class="ts">${t}</span><span class="tag">[${e.level}]</span><span class="component">[${escapeHtml(e.component)}]</span><span class="msg">${escapeHtml(e.msg)}</span></div>`;
    }
    if (e.source === "stderr") {
      return `<div class="tr source-stderr"><span class="ts">${t}</span><span class="tag">[stderr]</span><span class="msg">${escapeHtml(e.line)}</span></div>`;
    }
    if (e.source === "applog") {
      // The docker line already carries the compose service prefix
      // ("<service>-1  | …") so the originating service stays visible.
      return `<div class="tr source-applog channel-${e.channel}"><span class="ts">${t}</span><span class="tag">[applog:${e.channel}]</span><span class="component">[ct ${e.vmId}]</span><span class="msg">${escapeHtml(e.line)}</span></div>`;
    }
    if (e.source === "runner") {
      return `<div class="tr source-runner level-${e.level}"><span class="ts">${t}</span><span class="tag">[runner:${e.level}]</span><span class="msg">${escapeHtml(e.msg)}</span></div>`;
    }
    const secureMark = e.secure ? " (secure)" : "";
    return `<div class="tr source-subst"><span class="ts">${t}</span><span class="tag">[subst]</span><span class="msg">${escapeHtml(e.varName)}=${escapeHtml(e.redactedValue)}${secureMark} (line ${e.line})</span></div>`;
  });

  return [
    `<div class="trace-block">`,
    `  <div class="filters">${filters.join(" ")}</div>`,
    `  <div class="trace">`,
    ...rows.map((r) => `    ${r}`),
    `  </div>`,
    `</div>`,
  ].join("\n");
}
