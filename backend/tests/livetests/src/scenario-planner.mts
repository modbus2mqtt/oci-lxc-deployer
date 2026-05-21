/**
 * Scenario planning and selection for the live integration test runner.
 *
 * Pure functions for selecting test scenarios, resolving dependencies,
 * building CLI parameters, and assigning VM IDs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  VM_ID_START,
  type ResolvedScenario,
  type PlannedScenario,
  type RunMode,
} from "./livetest-types.mjs";
import type { ResolvedFilter } from "./test-set-registry.mjs";

/** Result of building params from a scenario params file */
export interface BuildParamsResult {
  params: { name: string; value: string }[];
  selectedAddons?: string[];
  stackId?: string;
}

/**
 * Collect selected scenarios and all their transitive dependencies.
 * Returns topologically sorted (dependencies first).
 * Detects circular dependencies.
 */
/**
 * Tie-breaking priority for scenarios in the same depends_on layer: install
 * runs before upgrade before reconfigure. Reasoning:
 *  - installation creates the source from scratch — must precede any consumer.
 *  - upgrade modifies in place (docker-compose) or clone-replaces with version
 *    bump (oci-image). It typically preserves the source's identity / addons.
 *  - reconfigure can destructively reshape addons and *always* clone-replaces.
 * Running reconfigure last minimises the blast radius when multiple
 * destructive consumers share a source (e.g. postgrest/reconf-ssl and
 * postgrest/upgrade-ssl both depend on postgrest/ssl — without this order the
 * one that runs first puts the source into `lock=migrate` and the second
 * fails with `resolve_host_volume failed for postgrest-ssl/proxvex`).
 */
const TASK_PRIORITY: Record<string, number> = {
  installation: 0,
  upgrade: 1,
  reconfigure: 2,
};

function taskPriority(s: ResolvedScenario): number {
  return TASK_PRIORITY[s.task ?? "installation"] ?? 99;
}

/**
 * Expand a set of scenario ids into the set of ids that should be treated
 * as "priority" by `collectWithDeps`: the input ids plus all transitive
 * `depends_on` ancestors found in `all`. Used to bias the topological
 * ordering toward catalog members and their dependency chains, so the
 * runner builds the snapshot infrastructure first (postgres → zitadel →
 * catalog members) before fanning out to leaf consumers. Combined with
 * the catalog-phase fail-fast gate, this also enables an early exit when
 * any catalog member fails.
 */
export function expandToPriorityClosure(
  ids: Iterable<string>,
  all: Map<string, ResolvedScenario>,
): Set<string> {
  const closure = new Set<string>();
  const walk = (id: string): void => {
    if (closure.has(id)) return;
    closure.add(id);
    const s = all.get(id);
    if (!s) return;
    for (const dep of s.depends_on ?? []) walk(dep);
  };
  for (const id of ids) walk(id);
  return closure;
}

export function collectWithDeps(
  selected: string[],
  all: Map<string, ResolvedScenario>,
  priorityIds?: ReadonlySet<string>,
): ResolvedScenario[] {
  const visited = new Set<string>();
  const visiting = new Set<string>(); // for cycle detection
  const ordered: ResolvedScenario[] = [];

  const priorityRank = (id: string): number => (priorityIds?.has(id) ? 0 : 1);

  function visit(id: string, chain: string[]) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Circular dependency detected: ${[...chain, id].join(" → ")}`);
    }

    visiting.add(id);
    const s = all.get(id);
    if (!s) throw new Error(`Unknown test scenario: ${id}`);

    // Visit deps in deterministic order. Primary key: priority membership
    // (catalog + transitive deps go first → unblock the snapshot phase
    // before leaf consumers). Then task priority (install < upgrade <
    // reconfigure). Then alphabetical for stability.
    const deps = [...(s.depends_on ?? [])].sort((a, b) => {
      const pra = priorityRank(a);
      const prb = priorityRank(b);
      if (pra !== prb) return pra - prb;
      const sa = all.get(a);
      const sb = all.get(b);
      const pa = sa ? taskPriority(sa) : 99;
      const pb = sb ? taskPriority(sb) : 99;
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });
    for (const dep of deps) {
      visit(dep, [...chain, id]);
    }

    visiting.delete(id);
    visited.add(id);
    ordered.push(s);
  }

  // Pre-sort selected[] — priority members first (catalog + their dep
  // ancestors), then task_priority, then alphabetical. With `--all` this
  // gives the snapshot phase a head start; with `@file` the listed
  // scenarios are typically the catalog members themselves.
  const sortedSelected = [...selected].sort((a, b) => {
    const pra = priorityRank(a);
    const prb = priorityRank(b);
    if (pra !== prb) return pra - prb;
    const sa = all.get(a);
    const sb = all.get(b);
    const pa = sa ? taskPriority(sa) : 99;
    const pb = sb ? taskPriority(sb) : 99;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
  for (const id of sortedSelected) {
    visit(id, []);
  }

  return ordered;
}

/**
 * After a dependency fails, partition remaining scenarios into:
 * - unaffected: scenarios that do NOT transitively depend on the failed dep
 * - blocked: scenarios that DO transitively depend on the failed dep
 *
 * This allows running unaffected tests first, maximizing coverage.
 */
export function partitionAfterFailure(
  failedDepId: string,
  remaining: PlannedScenario[],
  all: Map<string, ResolvedScenario>,
): { unaffected: PlannedScenario[]; blocked: PlannedScenario[] } {
  // Build transitive dependency set for each scenario
  function getTransitiveDeps(id: string, visited = new Set<string>()): Set<string> {
    if (visited.has(id)) return visited;
    visited.add(id);
    const scenario = all.get(id);
    if (scenario) {
      for (const dep of scenario.depends_on ?? []) {
        getTransitiveDeps(dep, visited);
      }
    }
    return visited;
  }

  const unaffected: PlannedScenario[] = [];
  const blocked: PlannedScenario[] = [];

  for (const step of remaining) {
    const deps = getTransitiveDeps(step.scenario.id);
    if (deps.has(failedDepId)) {
      blocked.push(step);
    } else {
      unaffected.push(step);
    }
  }

  return { unaffected, blocked };
}

/**
 * Phase 1 (`--parallel`) scheduling primitive — pure & unit-tested.
 *
 * Given the plan and a per-index lifecycle state, classify the still-pending
 * scenarios into:
 *  - `ready`   — every in-plan `depends_on` is `done` → may start now
 *  - `blocked` — at least one in-plan `depends_on` is `failed` → must skip
 *
 * `depends_on` entries that are not part of this plan are ignored (treated
 * as satisfied — same convention as the sequential planner). The caller
 * applies the concurrency cap and the running-count; this function only
 * answers "what is eligible given current state".
 */
/**
 * Pre-compute storage assignment per planned scenario. Each unique chain
 * (root dep + its consumer subtree) gets one storage; consumers inherit
 * from their dep. The round-robin counter only advances on ROOT picks
 * (so 3 root deps + 4 storages → no collision, slot 4 stays free).
 *
 * If `override` is set (e.g. `--volume-storage` CLI flag), every scenario
 * is pinned to that storage. If `parallelStorages` is empty, returns an
 * empty map (callers fall back to deployer-default storage).
 *
 * The parallel driver uses this map both for actual storage pinning AND
 * as a worker-occupancy gate: at most one scenario per storage runs
 * concurrently (each worker == one storage == one volume domain). This
 * eliminates lock contention on `/var/lock/pve-manager/pve-storage-<name>`.
 */
export function assignStoragePerScenario(
  planned: PlannedScenario[],
  parallelStorages: ReadonlyArray<string>,
  override?: string,
): Map<number, string> {
  const out = new Map<number, string>();
  if (override) {
    planned.forEach((_, i) => out.set(i, override));
    return out;
  }
  if (parallelStorages.length === 0) return out;

  const idxById = new Map<string, number>();
  planned.forEach((p, i) => idxById.set(p.scenario.id, i));
  let rootIdx = 0;
  for (let i = 0; i < planned.length; i++) {
    const p = planned[i]!;
    let picked: string | undefined;
    for (const depId of p.scenario.depends_on ?? []) {
      const di = idxById.get(depId);
      if (di !== undefined && out.has(di)) {
        picked = out.get(di);
        break;
      }
    }
    if (!picked) {
      picked = parallelStorages[rootIdx % parallelStorages.length]!;
      rootIdx++;
    }
    out.set(i, picked);
  }
  return out;
}

export function classifyParallel(
  planned: PlannedScenario[],
  state: ReadonlyArray<"pending" | "running" | "done" | "failed">,
): { ready: number[]; blocked: number[] } {
  const indexById = new Map<string, number>();
  planned.forEach((p, idx) => indexById.set(p.scenario.id, idx));
  const ready: number[] = [];
  const blocked: number[] = [];
  for (let idx = 0; idx < planned.length; idx++) {
    if (state[idx] !== "pending") continue;
    const deps = planned[idx]!.scenario.depends_on ?? [];
    let depBlocked = false;
    let allDone = true;
    for (const depId of deps) {
      const di = indexById.get(depId);
      if (di === undefined) continue; // dep not in this plan → satisfied
      if (state[di] === "failed") { depBlocked = true; break; }
      if (state[di] !== "done") allDone = false;
    }
    if (depBlocked) blocked.push(idx);
    else if (allDone) ready.push(idx);
  }
  return { ready, blocked };
}

/**
 * Select scenarios based on CLI argument.
 * - "app" → all scenarios under app/*
 * - "app/scenario" → exact match
 * - "--all" → everything
 * - "/regex/" or "!/regex/" → regex filter (include / negate)
 * - "a, b, c" → comma-list, each entry processed independently and unioned
 * Returns selected scenario IDs (without deps — call collectWithDeps after).
 */
export function selectScenarios(
  testArg: string,
  all: Map<string, ResolvedScenario>,
): string[] {
  // Comma-list (top-level only — never split inside a regex literal). Each
  // entry is processed by the single-arg logic; results are unioned in order
  // of first appearance.
  if (testArg.includes(",") && !isRegexLiteral(testArg)) {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const part of testArg.split(",").map((p) => p.trim()).filter(Boolean)) {
      for (const id of selectScenarios(part, all)) {
        if (!seen.has(id)) {
          seen.add(id);
          ordered.push(id);
        }
      }
    }
    if (ordered.length === 0) {
      throw new Error(`No test scenarios match comma-list: ${testArg}`);
    }
    return ordered;
  }

  // --all: select all scenarios
  if (testArg === "--all") {
    return [...all.keys()];
  }

  // Regex filter: /pattern/ (include) or !/pattern/ (exclude from all)
  // Examples: /postgres/, /^nginx/, /ssl$/, !/production/
  const isNegated = testArg.startsWith("!");
  const regexArg = isNegated ? testArg.slice(1) : testArg;
  if (regexArg.startsWith("/") && regexArg.endsWith("/")) {
    const regex = new RegExp(regexArg.slice(1, -1));
    const matches = [...all.keys()].filter((id) =>
      isNegated ? !regex.test(id) : regex.test(id),
    );
    if (matches.length === 0) {
      throw new Error(`No test scenarios match regex: ${testArg}`);
    }
    return matches;
  }

  // Exact match: "app/scenario"
  if (testArg.includes("/")) {
    if (!all.has(testArg)) {
      throw new Error(`Unknown test scenario: '${testArg}'`);
    }
    return [testArg];
  }

  // App-level match: "app" → all scenarios under app/*
  const matches = [...all.keys()].filter((id) => id.startsWith(`${testArg}/`));
  if (matches.length === 0) {
    throw new Error(
      `No test scenarios found for '${testArg}'. ` +
      `Expected json/applications/${testArg}/tests/test.json`,
    );
  }
  return matches;
}

/**
 * Apply a tag/preset filter to a pre-selected scenario list. Scenarios with
 * `untestable` set are unconditionally excluded unless `includeUntestable` is
 * true. The filter sees both declared scenario tags and computed tags injected
 * via `ResolvedScenario.computedTags`.
 *
 * Used by the runner to layer `--set <preset>` and `--tag …` on top of the
 * positional selector argument (app/regex/comma list/`--all`).
 */
export function applyTagFilter(
  ids: string[],
  all: Map<string, ResolvedScenario>,
  filter: ResolvedFilter | null,
  opts: { includeUntestable?: boolean } = {},
): string[] {
  const includeUntestable = opts.includeUntestable === true;
  const filtered: string[] = [];
  for (const id of ids) {
    const s = all.get(id);
    if (!s) continue;
    if (s.untestable && !includeUntestable) continue;
    if (!filter) {
      filtered.push(id);
      continue;
    }
    const tags = [...(s.tags ?? []), ...(s.computedTags ?? [])];
    if (filter.matches(id, tags)) {
      filtered.push(id);
    }
  }
  return filtered;
}

function isRegexLiteral(s: string): boolean {
  const trimmed = s.trim();
  const stripped = trimmed.startsWith("!") ? trimmed.slice(1) : trimmed;
  return stripped.startsWith("/") && stripped.endsWith("/");
}

/**
 * Classify the run mode based on the positional test argument and an explicit
 * `--snapshot <name>` flag. Pure function — does not touch the filesystem.
 *
 *  - `"--all"`            → `all`
 *  - argument starts `@`  → `file`
 *  - `snapshotName` set   → `snapshot-build`
 *  - anything else        → `single` (comma-list, app/scenario, regex, app)
 */
export function classifyRunMode(
  testArg: string,
  snapshotName: string | null,
): RunMode {
  if (snapshotName) return "snapshot-build";
  if (testArg === "--all") return "all";
  if (testArg.startsWith("@")) return "file";
  return "single";
}

/**
 * Load the curated snapshot catalog from disk. Members are top-level scenario
 * ids whose pct-snapshot is (re-)created after each successful test run.
 * Transitive deps inherit the snapshot via the per-member snapshot pass.
 *
 * Returns an empty set + warn-log when the file is missing, so the runner can
 * still operate (no snapshots created); existence is therefore optional.
 */
export function loadSnapshotCatalog(projectRoot: string): Set<string> {
  const file = path.join(projectRoot, "e2e", "snapshot-catalog.json");
  if (!existsSync(file)) {
    return new Set();
  }
  const raw = readFileSync(file, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" || parsed === null ||
    !Array.isArray((parsed as { members?: unknown }).members)
  ) {
    throw new Error(
      `Invalid snapshot catalog ${file}: expected { members: string[] }`,
    );
  }
  const members = (parsed as { members: unknown[] }).members;
  const out = new Set<string>();
  for (const m of members) {
    if (typeof m !== "string" || m.trim() === "") {
      throw new Error(`Invalid snapshot catalog entry in ${file}: ${String(m)}`);
    }
    out.add(m.trim());
  }
  return out;
}

/**
 * Parse a `.lst` scenario-list file. One scenario id per line; `#` introduces
 * a comment to end-of-line; blank lines are ignored. Returns the order-
 * preserving comma-separated string the existing `selectScenarios()` parser
 * already consumes, so `@<file>` plugs in without a new selection path.
 */
export function loadScenarioListFromFile(filePath: string): string {
  if (!existsSync(filePath)) {
    throw new Error(`Scenario list file not found: ${filePath}`);
  }
  const raw = readFileSync(filePath, "utf-8");
  const ids: string[] = [];
  for (const line of raw.split("\n")) {
    const noComment = line.replace(/#.*$/, "").trim();
    if (noComment === "") continue;
    ids.push(noComment);
  }
  if (ids.length === 0) {
    throw new Error(`Scenario list file is empty: ${filePath}`);
  }
  return ids.join(",");
}

/**
 * Build CLI params for a scenario.
 * Merges base params with scenario params from the API response.
 * Also extracts selectedAddons and stackId.
 * Supports set mode and append mode (for multiline vars like envs).
 * Resolves file: references using upload data from the API (written to tmpDir).
 */
export function buildParams(
  scenario: ResolvedScenario,
  baseParams: { name: string; value: string }[],
  templateVars: Record<string, string>,
  tmpDir?: string,
): BuildParamsResult {
  const params = baseParams.map((p) => ({ ...p }));

  if (!scenario.params || scenario.params.length === 0) {
    return {
      params,
      ...(scenario.selectedAddons ? { selectedAddons: scenario.selectedAddons } : {}),
      ...(scenario.stackId ? { stackId: scenario.stackId } : {}),
    };
  }

  // Write upload files to tmpDir so file: references can be resolved
  const uploadMap = new Map<string, string>();
  if (tmpDir && scenario.uploads) {
    const uploadsDir = path.join(tmpDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    for (const upload of scenario.uploads) {
      const filePath = path.join(uploadsDir, upload.name);
      writeFileSync(filePath, Buffer.from(upload.content, "base64"));
      uploadMap.set(upload.name, filePath);
    }
  }

  // These params are controlled by the test runner (VM allocation) and must not be overridden
  const runnerControlled = new Set(["vm_id", "hostname"]);

  for (const p of scenario.params) {
    // Skip runner-controlled params — they're set via baseParams
    if (runnerControlled.has(p.name) && !p.append) continue;

    // Substitute template variables in values
    let value = String(p.value ?? "");
    for (const [key, val] of Object.entries(templateVars)) {
      value = value.replace(
        new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"),
        val,
      );
    }
    // Resolve environment variable references: ${VAR_NAME}
    value = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, envName: string) => {
      return process.env[envName] ?? "";
    });

    if (p.append) {
      let appendVal = p.append;
      for (const [key, val] of Object.entries(templateVars)) {
        appendVal = appendVal.replace(
          new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g"),
          val,
        );
      }
      // Append mode: extend multiline variable (e.g. envs)
      const existing = params.find((b) => b.name === p.name);
      const line = `${appendVal}=${value}`;
      if (existing) {
        existing.value = existing.value
          ? `${existing.value}\n${line}`
          : line;
      } else {
        params.push({ name: p.name, value: line });
      }
    } else {
      // Set mode: override or add
      // Resolve file: references using uploads from API
      if (value.startsWith("file:")) {
        const fileName = value.slice(5);
        const localPath = uploadMap.get(fileName);
        if (localPath) {
          value = `file:${localPath}`;
        }
      }
      const existing = params.find((b) => b.name === p.name);
      if (existing) {
        existing.value = value;
      } else {
        params.push({ name: p.name, value });
      }
    }
  }

  return {
    params,
    ...(scenario.selectedAddons ? { selectedAddons: scenario.selectedAddons } : {}),
    ...(scenario.stackId ? { stackId: scenario.stackId } : {}),
  };
}

/**
 * Plan scenarios: assign VM IDs, hostnames, and stack names.
 */
/**
 * Plan VM IDs for scenarios. Uses a global ID map based on ALL known scenarios
 * so that VM IDs are stable regardless of which subset of tests is selected.
 * This prevents ID collisions when running tests sequentially (e.g. zitadel/default
 * then zitadel/ssl — both need their own postgres VM with different IDs).
 */
export function planScenarios(
  scenarios: ResolvedScenario[],
  appStacktypes: Map<string, string | string[]>,
  allScenarios?: Map<string, ResolvedScenario>,
): PlannedScenario[] {
  // Build stable VM ID map from ALL known scenarios (sorted for determinism)
  const globalIdMap = new Map<string, number>();
  if (allScenarios) {
    // Collect all scenario IDs including their transitive dependencies
    const allIds = new Set<string>();
    const addWithDeps = (id: string) => {
      if (allIds.has(id)) return;
      allIds.add(id);
      const s = allScenarios.get(id);
      if (s?.depends_on) {
        for (const dep of s.depends_on) addWithDeps(dep);
      }
    };
    for (const id of allScenarios.keys()) addWithDeps(id);

    // Sort and assign stable IDs
    let nextId = VM_ID_START;
    for (const id of [...allIds].sort()) {
      const s = allScenarios.get(id);
      globalIdMap.set(id, s?.vm_id ?? nextId++);
    }
  }

  let fallbackId = VM_ID_START;
  return scenarios.map((scenario) => {
    const vmId = scenario.vm_id ?? globalIdMap.get(scenario.id) ?? fallbackId++;
    const rawStacktype = appStacktypes.get(scenario.application);
    const stacktypes = rawStacktype ? (Array.isArray(rawStacktype) ? rawStacktype : [rawStacktype]) : [];
    const hasStacktype = stacktypes.length > 0;

    // Stack name defaults to scenario variant (e.g. "default", "ssl"),
    // but can be overridden via scenario.stack_name so cross-app reconfigure
    // tests can join an existing stack instead of forking a fresh one.
    const stackName = scenario.stack_name ?? scenario.id.split("/")[1] ?? "default";

    return {
      vmId,
      hostname: `${scenario.application}-${stackName}`,
      stackName,
      scenario,
      hasStacktype,
      isDependency: false,
      skipExecution: false,
    };
  });
}
