import { describe, it, expect } from "vitest";
import {
  collectWithDeps,
  selectScenarios,
  buildParams,
  planScenarios,
  partitionAfterFailure,
  resolveDepSnapshotName,
  type ResolvedScenario,
  type PlannedScenario,
} from "./live-test-runner.mjs";
import { classifyParallel, assignStoragePerScenario } from "./scenario-planner.mjs";

// ── Tests ──

describe("collectWithDeps", () => {
  function makeScenarios(
    defs: Record<string, { depends_on?: string[]; task?: string }>,
  ): Map<string, ResolvedScenario> {
    const all = new Map<string, ResolvedScenario>();
    for (const [id, def] of Object.entries(defs)) {
      const [app] = id.split("/");
      all.set(id, {
        id,
        application: app!,
        description: `Test ${id}`,
        ...def,
      });
    }
    return all;
  }

  it("single scenario without deps returns just that scenario", () => {
    const all = makeScenarios({ "app/default": {} });
    const result = collectWithDeps(["app/default"], all);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("app/default");
  });

  it("scenario with deps returns deps first (topological order)", () => {
    const all = makeScenarios({
      "postgres/default": {},
      "zitadel/default": { depends_on: ["postgres/default"] },
    });

    const result = collectWithDeps(["zitadel/default"], all);
    expect(result).toHaveLength(2);
    expect(result[0]!.id).toBe("postgres/default");
    expect(result[1]!.id).toBe("zitadel/default");
  });

  it("transitive deps: A→B→C returns [C, B, A]", () => {
    const all = makeScenarios({
      "c/default": {},
      "b/default": { depends_on: ["c/default"] },
      "a/default": { depends_on: ["b/default"] },
    });

    const result = collectWithDeps(["a/default"], all);
    expect(result.map((s) => s.id)).toEqual([
      "c/default",
      "b/default",
      "a/default",
    ]);
  });

  it("circular dependency throws error", () => {
    const all = makeScenarios({
      "a/default": { depends_on: ["b/default"] },
      "b/default": { depends_on: ["a/default"] },
    });

    expect(() => collectWithDeps(["a/default"], all)).toThrow(
      /Circular dependency/,
    );
  });

  it("unknown dependency reference throws error", () => {
    const all = makeScenarios({
      "app/default": { depends_on: ["missing/default"] },
    });

    expect(() => collectWithDeps(["app/default"], all)).toThrow(
      /Unknown test scenario: missing\/default/,
    );
  });

  it("shared deps are included only once", () => {
    const all = makeScenarios({
      "postgres/default": {},
      "app-a/default": { depends_on: ["postgres/default"] },
      "app-b/default": { depends_on: ["postgres/default"] },
    });

    const result = collectWithDeps(["app-a/default", "app-b/default"], all);
    expect(result).toHaveLength(3);
    const ids = result.map((s) => s.id);
    expect(ids.filter((id) => id === "postgres/default")).toHaveLength(1);
  });

  it("siblings of same source run install < upgrade < reconfigure", () => {
    // postgrest/ssl is the shared source; upgrade-ssl and reconf-ssl both
    // depend on it. Without task-priority sort, they'd be ordered
    // alphabetically (reconf-ssl before upgrade-ssl) and reconfigure would
    // destroy the source before upgrade runs.
    const all = makeScenarios({
      "postgrest/ssl": {},
      "postgrest/reconf-ssl": {
        task: "reconfigure",
        depends_on: ["postgrest/ssl"],
      },
      "postgrest/upgrade-ssl": {
        task: "upgrade",
        depends_on: ["postgrest/ssl"],
      },
    });
    const result = collectWithDeps(
      ["postgrest/upgrade-ssl", "postgrest/reconf-ssl"],
      all,
    );
    expect(result.map((s) => s.id)).toEqual([
      "postgrest/ssl",
      "postgrest/upgrade-ssl",
      "postgrest/reconf-ssl",
    ]);
  });

  it("task-priority sort still respects depends_on chains", () => {
    // reconfigure that depends on upgrade must come AFTER upgrade despite
    // alphabetical order suggesting otherwise.
    const all = makeScenarios({
      "app/default": {},
      "app/upgrade": { task: "upgrade", depends_on: ["app/default"] },
      "app/reconf-after-upgrade": {
        task: "reconfigure",
        depends_on: ["app/upgrade"],
      },
    });
    const result = collectWithDeps(["app/reconf-after-upgrade"], all);
    expect(result.map((s) => s.id)).toEqual([
      "app/default",
      "app/upgrade",
      "app/reconf-after-upgrade",
    ]);
  });

  it("installation always runs before its upgrade/reconfigure consumers", () => {
    const all = makeScenarios({
      "app/default": {},
      "app/upgrade": { task: "upgrade", depends_on: ["app/default"] },
    });
    // Even if upgrade is selected first, install (its dep) wins.
    const result = collectWithDeps(["app/upgrade", "app/default"], all);
    expect(result[0]!.id).toBe("app/default");
    expect(result[1]!.id).toBe("app/upgrade");
  });
});

describe("selectScenarios", () => {
  function makeAll(): Map<string, ResolvedScenario> {
    const entries: [string, ResolvedScenario][] = [
      "pgadmin/ssl",
      "postgres/default",
      "postgres/ssl",
      "zitadel/default",
      "zitadel/ssl",
    ].map((id) => {
      const [app] = id.split("/");
      return [id, {
        id,
        application: app!,
        description: `Test ${id}`,
      }];
    });
    return new Map(entries);
  }

  it("--all returns everything", () => {
    const all = makeAll();
    const result = selectScenarios("--all", all);
    expect(result).toHaveLength(5);
  });

  it("app/scenario returns exact match", () => {
    const all = makeAll();
    const result = selectScenarios("pgadmin/ssl", all);
    expect(result).toEqual(["pgadmin/ssl"]);
  });

  it("app name returns all scenarios under app/*", () => {
    const all = makeAll();
    const result = selectScenarios("postgres", all);
    expect(result).toEqual(["postgres/default", "postgres/ssl"]);
  });

  it("unknown app throws error", () => {
    const all = makeAll();
    expect(() => selectScenarios("nonexistent", all)).toThrow(
      /No test scenarios found for 'nonexistent'/,
    );
  });

  it("unknown exact scenario throws error", () => {
    const all = makeAll();
    expect(() => selectScenarios("pgadmin/nonexistent", all)).toThrow(
      /Unknown test scenario/,
    );
  });

  it("comma list combines entries (scenarios + apps)", () => {
    const all = makeAll();
    const result = selectScenarios("postgres/ssl, zitadel", all);
    expect(result).toEqual(["postgres/ssl", "zitadel/default", "zitadel/ssl"]);
  });

  it("comma list deduplicates", () => {
    const all = makeAll();
    const result = selectScenarios("postgres, postgres/ssl", all);
    expect(result).toEqual(["postgres/default", "postgres/ssl"]);
  });

  it("comma list trims whitespace", () => {
    const all = makeAll();
    const result = selectScenarios("  postgres/ssl  ,  zitadel/default  ", all);
    expect(result).toEqual(["postgres/ssl", "zitadel/default"]);
  });
});

describe("buildParams", () => {
  const defaultBase = [
    { name: "hostname", value: "test-host" },
    { name: "bridge", value: "vmbr0" },
    { name: "vm_id", value: "200" },
  ];

  const defaultVars = {
    vm_id: "200",
    hostname: "test-host",
    stack_name: "default",
  };

  it("base params always present when no scenario params", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.params).toEqual(defaultBase);
  });

  it("set mode: adds new param", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
      params: [{ name: "custom_param", value: "custom_value" }],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.params).toContainEqual({ name: "custom_param", value: "custom_value" });
  });

  it("set mode: overrides existing param", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
      params: [{ name: "bridge", value: "vmbr99" }],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.params.find((p) => p.name === "bridge")!.value).toBe("vmbr99");
  });

  it("runner-controlled params (vm_id, hostname) are not overridden by scenario", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
      params: [
        { name: "vm_id", value: "999" },
        { name: "hostname", value: "overridden" },
      ],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.params.find((p) => p.name === "vm_id")!.value).toBe("200");
    expect(result.params.find((p) => p.name === "hostname")!.value).toBe("test-host");
  });

  it("append mode: builds multiline value", () => {
    const scenario: ResolvedScenario = {
      id: "pgadmin/ssl",
      application: "pgadmin",
      description: "Test pgadmin/ssl",
      params: [
        { name: "envs", append: "PGADMIN_DEFAULT_EMAIL", value: "admin@test.local" },
        { name: "envs", append: "PGADMIN_DEFAULT_PASSWORD", value: "testpass123" },
      ],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    const envs = result.params.find((p) => p.name === "envs")!;
    expect(envs.value).toBe(
      "PGADMIN_DEFAULT_EMAIL=admin@test.local\nPGADMIN_DEFAULT_PASSWORD=testpass123",
    );
  });

  it("append mode: appends to existing value", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
      params: [
        { name: "envs", append: "NEW_VAR", value: "new_value" },
      ],
    };

    const base = [
      ...defaultBase,
      { name: "envs", value: "EXISTING=old" },
    ];

    const result = buildParams(scenario, base, defaultVars);
    const envs = result.params.find((p) => p.name === "envs")!;
    expect(envs.value).toBe("EXISTING=old\nNEW_VAR=new_value");
  });

  it("selectedAddons extracted from scenario", () => {
    const scenario: ResolvedScenario = {
      id: "mosquitto/default",
      application: "mosquitto",
      description: "Test mosquitto/default",
      params: [],
      selectedAddons: ["addon-ssl"],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.selectedAddons).toEqual(["addon-ssl"]);
  });

  it("template variable substitution works", () => {
    const scenario: ResolvedScenario = {
      id: "myapp/default",
      application: "myapp",
      description: "Test myapp/default",
      params: [{ name: "custom", value: "host-{{ vm_id }}-{{ hostname }}" }],
    };

    const result = buildParams(scenario, [...defaultBase], defaultVars);
    expect(result.params.find((p) => p.name === "custom")!.value).toBe("host-200-test-host");
  });
});

// ── planScenarios ──

describe("planScenarios", () => {
  function makeResolved(id: string, opts?: Partial<ResolvedScenario>): ResolvedScenario {
    const [app] = id.split("/");
    return { id, application: app!, description: `Test ${id}`, ...opts };
  }

  it("assigns sequential VM IDs starting at 200", () => {
    const scenarios = [makeResolved("postgres/default"), makeResolved("zitadel/default")];
    const result = planScenarios(scenarios, new Map());
    expect(result[0]!.vmId).toBe(200);
    expect(result[1]!.vmId).toBe(201);
  });

  it("uses explicit vm_id from scenario when set", () => {
    const scenarios = [makeResolved("myapp/default", { vm_id: 500 })];
    const result = planScenarios(scenarios, new Map());
    expect(result[0]!.vmId).toBe(500);
  });

  it("generates hostname from app + variant", () => {
    const scenarios = [makeResolved("postgres/ssl")];
    const result = planScenarios(scenarios, new Map());
    expect(result[0]!.hostname).toBe("postgres-ssl");
  });

  it("stack name is the scenario variant", () => {
    const scenarios = [makeResolved("gitea/ssl")];
    const result = planScenarios(scenarios, new Map());
    expect(result[0]!.stackName).toBe("ssl");
  });

  it("detects hasStacktype from appStacktypes map", () => {
    const stacktypes = new Map<string, string | string[]>([["postgres", "postgres"]]);
    const scenarios = [makeResolved("postgres/default"), makeResolved("nginx/default")];
    const result = planScenarios(scenarios, stacktypes);
    expect(result[0]!.hasStacktype).toBe(true);
    expect(result[1]!.hasStacktype).toBe(false);
  });

  it("initializes isDependency and skipExecution to false", () => {
    const scenarios = [makeResolved("myapp/default")];
    const result = planScenarios(scenarios, new Map());
    expect(result[0]!.isDependency).toBe(false);
    expect(result[0]!.skipExecution).toBe(false);
  });
});

// ── Snapshot naming ──

describe("snapshot naming", () => {
  /** Reproduces the snapshot name logic from live-test-runner.mts */
  function snapshotName(scenarioId: string): string {
    return "dep-" + scenarioId.replace(/\//g, "-");
  }

  it("generates correct name for default scenario", () => {
    expect(snapshotName("postgres/default")).toBe("dep-postgres-default");
  });

  it("generates correct name for ssl scenario", () => {
    expect(snapshotName("zitadel/ssl")).toBe("dep-zitadel-ssl");
  });

  it("finds best snapshot: latest dependency in chain", () => {
    // Given deps: postgres/default → zitadel/default
    // If dep-zitadel-default exists, it's the best (includes postgres state)
    const deps = ["postgres/default", "zitadel/default"];
    const existingSnapshots = new Set(["dep-postgres-default", "dep-zitadel-default"]);

    // Walk backwards to find the latest existing snapshot
    let bestSnap: string | null = null;
    for (let i = deps.length - 1; i >= 0; i--) {
      const name = snapshotName(deps[i]!);
      if (existingSnapshots.has(name)) {
        bestSnap = name;
        break;
      }
    }
    expect(bestSnap).toBe("dep-zitadel-default");
  });

  it("falls back to earlier snapshot if latest missing", () => {
    const deps = ["postgres/default", "zitadel/default"];
    const existingSnapshots = new Set(["dep-postgres-default"]);

    let bestSnap: string | null = null;
    for (let i = deps.length - 1; i >= 0; i--) {
      const name = snapshotName(deps[i]!);
      if (existingSnapshots.has(name)) {
        bestSnap = name;
        break;
      }
    }
    expect(bestSnap).toBe("dep-postgres-default");
  });

  it("returns null if no snapshot exists", () => {
    const deps = ["postgres/default"];
    const existingSnapshots = new Set<string>();

    let bestSnap: string | null = null;
    for (let i = deps.length - 1; i >= 0; i--) {
      const name = snapshotName(deps[i]!);
      if (existingSnapshots.has(name)) {
        bestSnap = name;
        break;
      }
    }
    expect(bestSnap).toBeNull();
  });

  it("skip logic: all deps up to best snapshot are skipped", () => {
    const deps = ["postgres/default", "zitadel/default", "gitea/default"];
    const bestSnap = "dep-zitadel-default";

    const skipped: string[] = [];
    for (const dep of deps) {
      skipped.push(dep);
      if (snapshotName(dep) === bestSnap) break;
    }
    expect(skipped).toEqual(["postgres/default", "zitadel/default"]);
    // gitea/default is NOT skipped — it needs to be installed
  });
});

// ── partitionAfterFailure ──

describe("partitionAfterFailure", () => {
  function makeResolved(id: string, opts?: Partial<ResolvedScenario>): ResolvedScenario {
    const [app] = id.split("/");
    return { id, application: app!, description: `Test ${id}`, ...opts };
  }

  function makePlanned(id: string, vmId: number, opts?: Partial<ResolvedScenario>): PlannedScenario {
    return {
      vmId,
      hostname: id.replace("/", "-"),
      stackName: id.split("/")[1] ?? "default",
      scenario: makeResolved(id, opts),
      hasStacktype: false,
      isDependency: false,
      skipExecution: false,
    };
  }

  it("separates unaffected from blocked when a dependency fails", () => {
    const all = new Map<string, ResolvedScenario>([
      ["postgres/default", makeResolved("postgres/default")],
      ["zitadel/default", makeResolved("zitadel/default", { depends_on: ["postgres/default"] })],
      ["gitea/default", makeResolved("gitea/default", { depends_on: ["zitadel/default"] })],
      ["nginx/default", makeResolved("nginx/default")],
      ["postgrest/default", makeResolved("postgrest/default", { depends_on: ["postgres/default"] })],
    ]);

    const remaining = [
      makePlanned("gitea/default", 203, { depends_on: ["zitadel/default"] }),
      makePlanned("nginx/default", 204),
      makePlanned("postgrest/default", 205, { depends_on: ["postgres/default"] }),
    ];

    // zitadel failed → gitea is blocked, nginx + postgrest are unaffected
    const { unaffected, blocked } = partitionAfterFailure("zitadel/default", remaining, all);
    expect(unaffected.map((p) => p.scenario.id)).toEqual(["nginx/default", "postgrest/default"]);
    expect(blocked.map((p) => p.scenario.id)).toEqual(["gitea/default"]);
  });

  it("all tests blocked when root dependency fails", () => {
    const all = new Map<string, ResolvedScenario>([
      ["postgres/default", makeResolved("postgres/default")],
      ["zitadel/default", makeResolved("zitadel/default", { depends_on: ["postgres/default"] })],
      ["gitea/default", makeResolved("gitea/default", { depends_on: ["zitadel/default", "postgres/default"] })],
    ]);

    const remaining = [
      makePlanned("zitadel/default", 201, { depends_on: ["postgres/default"] }),
      makePlanned("gitea/default", 202, { depends_on: ["zitadel/default", "postgres/default"] }),
    ];

    const { unaffected, blocked } = partitionAfterFailure("postgres/default", remaining, all);
    expect(unaffected).toHaveLength(0);
    expect(blocked.map((p) => p.scenario.id)).toEqual(["zitadel/default", "gitea/default"]);
  });

  it("no tests blocked when independent scenario fails", () => {
    const all = new Map<string, ResolvedScenario>([
      ["nginx/default", makeResolved("nginx/default")],
      ["postgres/default", makeResolved("postgres/default")],
    ]);

    const remaining = [
      makePlanned("postgres/default", 201),
    ];

    const { unaffected, blocked } = partitionAfterFailure("nginx/default", remaining, all);
    expect(unaffected.map((p) => p.scenario.id)).toEqual(["postgres/default"]);
    expect(blocked).toHaveLength(0);
  });
});

// ── Phase 0: per-application dependency-snapshot scope ──

describe("resolveDepSnapshotName", () => {
  function plan(
    entries: Array<{ id: string; isDependency?: boolean }>,
  ): PlannedScenario[] {
    return entries.map((e, i) => {
      const [app] = e.id.split("/");
      return {
        vmId: 200 + i,
        hostname: e.id.replace("/", "-"),
        stackName: e.id.split("/")[1] ?? "default",
        scenario: { id: e.id, application: app!, description: e.id },
        hasStacktype: false,
        isDependency: e.isDependency ?? false,
        skipExecution: false,
      };
    });
  }

  it("returns null for --all (never snapshots a broad run)", () => {
    const planned = plan([
      { id: "postgres/default", isDependency: true },
      { id: "zitadel/default" },
    ]);
    const selected = new Set(["postgres/default", "zitadel/default"]);
    expect(resolveDepSnapshotName("--all", planned, selected)).toBeNull();
  });

  it("returns <app>_deps for a single selected application (deps excluded)", () => {
    // `zitadel/default` selected; postgres pulled in only as a dependency.
    const planned = plan([
      { id: "postgres/default", isDependency: true },
      { id: "zitadel/default" },
    ]);
    const selected = new Set(["zitadel/default"]);
    expect(resolveDepSnapshotName("zitadel/default", planned, selected)).toBe(
      "zitadel_deps",
    );
  });

  it("returns <app>_deps when several scenarios of the SAME app are selected", () => {
    const planned = plan([
      { id: "postgres/default", isDependency: true },
      { id: "postgres/ssl", isDependency: true },
      { id: "zitadel/default" },
      { id: "zitadel/ssl" },
    ]);
    const selected = new Set(["zitadel/default", "zitadel/ssl"]);
    expect(
      resolveDepSnapshotName("zitadel/default,zitadel/ssl", planned, selected),
    ).toBe("zitadel_deps");
  });

  it("returns null for a multi-application subset (no cross-app pollution)", () => {
    const planned = plan([
      { id: "postgres/default", isDependency: true },
      { id: "zitadel/default" },
      { id: "gitea/default" },
    ]);
    const selected = new Set(["zitadel/default", "gitea/default"]);
    expect(
      resolveDepSnapshotName("zitadel/default,gitea/default", planned, selected),
    ).toBeNull();
  });

  it("returns null when a consumer of the selected app is also selected", () => {
    // zitadel/default + nginx/oidc-ssl (nginx depends on zitadel) → two
    // selected applications → no snapshot, so zitadel-as-dependency state
    // can never be baked into a snapshot a later narrow run would reuse.
    const planned = plan([
      { id: "postgres/default", isDependency: true },
      { id: "zitadel/default", isDependency: true },
      { id: "nginx/oidc-ssl" },
    ]);
    const selected = new Set(["zitadel/default", "nginx/oidc-ssl"]);
    expect(
      resolveDepSnapshotName("zitadel/default,nginx/oidc-ssl", planned, selected),
    ).toBeNull();
  });
});

// ── Phase 1: parallel scheduling primitive ──

describe("classifyParallel", () => {
  type St = "pending" | "running" | "done" | "failed";
  function plan(
    entries: Array<{ id: string; depends_on?: string[] }>,
  ): PlannedScenario[] {
    return entries.map((e, i) => {
      const [app] = e.id.split("/");
      return {
        vmId: 200 + i,
        hostname: e.id.replace("/", "-"),
        stackName: e.id.split("/")[1] ?? "default",
        scenario: {
          id: e.id,
          application: app!,
          description: e.id,
          ...(e.depends_on ? { depends_on: e.depends_on } : {}),
        },
        hasStacktype: false,
        isDependency: false,
        skipExecution: false,
      };
    });
  }

  it("only dependency-free scenarios are ready initially", () => {
    const p = plan([
      { id: "postgres/default" },
      { id: "zitadel/default", depends_on: ["postgres/default"] },
    ]);
    const { ready, blocked } = classifyParallel(p, ["pending", "pending"]);
    expect(ready).toEqual([0]);
    expect(blocked).toEqual([]);
  });

  it("a dependent becomes ready once its dependency is done", () => {
    const p = plan([
      { id: "postgres/default" },
      { id: "zitadel/default", depends_on: ["postgres/default"] },
    ]);
    const { ready } = classifyParallel(p, ["done", "pending"]);
    expect(ready).toEqual([1]);
  });

  it("a dependent is blocked when its dependency failed", () => {
    const p = plan([
      { id: "postgres/default" },
      { id: "zitadel/default", depends_on: ["postgres/default"] },
    ]);
    const { ready, blocked } = classifyParallel(p, ["failed", "pending"]);
    expect(ready).toEqual([]);
    expect(blocked).toEqual([1]);
  });

  it("ignores depends_on entries that are not part of the plan", () => {
    const p = plan([{ id: "zitadel/default", depends_on: ["postgres/ssl"] }]);
    const { ready, blocked } = classifyParallel(p, ["pending"]);
    expect(ready).toEqual([0]);
    expect(blocked).toEqual([]);
  });

  it("running / done / failed scenarios are never re-classified", () => {
    const p = plan([
      { id: "a/default" },
      { id: "b/default" },
      { id: "c/default" },
    ]);
    const state: St[] = ["running", "done", "failed"];
    const { ready, blocked } = classifyParallel(p, state);
    expect(ready).toEqual([]);
    expect(blocked).toEqual([]);
  });

  it("independent scenarios are all ready (cap is the driver's concern)", () => {
    const p = plan([
      { id: "a/default" },
      { id: "b/default" },
      { id: "c/default" },
    ]);
    const { ready } = classifyParallel(p, ["pending", "pending", "pending"]);
    expect(ready).toEqual([0, 1, 2]);
  });
});

// ── assignStoragePerScenario ──

describe("assignStoragePerScenario", () => {
  function plan(
    entries: Array<{ id: string; depends_on?: string[] }>,
  ): PlannedScenario[] {
    return entries.map((e, i) => {
      const [app] = e.id.split("/");
      return {
        vmId: 200 + i,
        hostname: e.id.replace("/", "-"),
        stackName: e.id.split("/")[1] ?? "default",
        scenario: {
          id: e.id,
          application: app!,
          description: e.id,
          ...(e.depends_on ? { depends_on: e.depends_on } : {}),
        },
        hasStacktype: false,
        isDependency: false,
        skipExecution: false,
      };
    });
  }

  it("3 root deps + 4 storages → roots take slots 0/1/2, slot 3 unused", () => {
    const p = plan([
      { id: "postgres/default" },
      { id: "postgres/ssl" },
      { id: "postgres/mtls" },
    ]);
    const m = assignStoragePerScenario(p, ["s0", "s1", "s2", "s3"]);
    expect(m.get(0)).toBe("s0");
    expect(m.get(1)).toBe("s1");
    expect(m.get(2)).toBe("s2");
    // s3 stays free — exactly the "Es darf nur bis 3 gehen" property.
    expect([...m.values()]).not.toContain("s3");
  });

  it("consumer inherits its dep's storage (no extra root slot consumed)", () => {
    const p = plan([
      { id: "postgres/default" },
      { id: "zitadel/default", depends_on: ["postgres/default"] },
      { id: "postgres/ssl" },
    ]);
    const m = assignStoragePerScenario(p, ["s0", "s1", "s2"]);
    expect(m.get(0)).toBe("s0"); // root
    expect(m.get(1)).toBe("s0"); // consumer → inherits postgres/default
    expect(m.get(2)).toBe("s1"); // next root → next slot (not s2!)
  });

  it("two consumers of the same dep both inherit its storage", () => {
    const p = plan([
      { id: "postgres/ssl" },
      { id: "zitadel/ssl", depends_on: ["postgres/ssl"] },
      { id: "zitadel/mtls", depends_on: ["postgres/ssl"] },
    ]);
    const m = assignStoragePerScenario(p, ["s0", "s1"]);
    expect(m.get(0)).toBe("s0");
    expect(m.get(1)).toBe("s0");
    expect(m.get(2)).toBe("s0");
  });

  it("more roots than storages wraps with full awareness (5 roots, 4 storages)", () => {
    const p = plan([
      { id: "a/default" }, { id: "b/default" }, { id: "c/default" },
      { id: "d/default" }, { id: "e/default" },
    ]);
    const m = assignStoragePerScenario(p, ["s0", "s1", "s2", "s3"]);
    expect(m.get(0)).toBe("s0");
    expect(m.get(1)).toBe("s1");
    expect(m.get(2)).toBe("s2");
    expect(m.get(3)).toBe("s3");
    expect(m.get(4)).toBe("s0"); // wrap
  });

  it("override pins every scenario to the given storage", () => {
    const p = plan([
      { id: "postgres/default" },
      { id: "zitadel/default", depends_on: ["postgres/default"] },
    ]);
    const m = assignStoragePerScenario(p, ["s0", "s1"], "custom");
    expect(m.get(0)).toBe("custom");
    expect(m.get(1)).toBe("custom");
  });

  it("no storages available → empty map", () => {
    const p = plan([{ id: "postgres/default" }]);
    const m = assignStoragePerScenario(p, []);
    expect(m.size).toBe(0);
  });
});

// ── Worker-occupancy gate (simulator) ──
//
// Mirrors the busyStorages logic from executeScenariosParallel: each
// storage is a worker; a scenario is dispatched only when its assigned
// storage is idle. Simulation here proves the invariants without
// spinning up the real executor.

describe("worker-occupancy gate (busyStorages)", () => {
  function plan(
    entries: Array<{ id: string; depends_on?: string[] }>,
  ): PlannedScenario[] {
    return entries.map((e, i) => {
      const [app] = e.id.split("/");
      return {
        vmId: 200 + i,
        hostname: e.id.replace("/", "-"),
        stackName: e.id.split("/")[1] ?? "default",
        scenario: {
          id: e.id,
          application: app!,
          description: e.id,
          ...(e.depends_on ? { depends_on: e.depends_on } : {}),
        },
        hasStacktype: false,
        isDependency: false,
        skipExecution: false,
      };
    });
  }

  type St = "pending" | "running" | "done" | "failed";

  // Mimics the inner ready-loop from executeScenariosParallel.
  function tickDispatch(
    planned: PlannedScenario[],
    state: St[],
    busy: Set<string>,
    storageByIdx: Map<number, string>,
    cap: number,
  ): number[] {
    const dispatched: number[] = [];
    const { ready } = classifyParallel(planned, state);
    const active = state.filter((s) => s === "running").length;
    let slot = cap - active;
    for (const idx of ready) {
      if (slot <= 0) break;
      const s = storageByIdx.get(idx);
      if (s && busy.has(s)) continue;
      if (s) busy.add(s);
      state[idx] = "running";
      dispatched.push(idx);
      slot--;
    }
    return dispatched;
  }

  it("3 postgres roots fill 3 worker slots, 4th storage stays idle", () => {
    const planned = plan([
      { id: "postgres/default" },
      { id: "postgres/ssl" },
      { id: "postgres/mtls" },
    ]);
    const storage = assignStoragePerScenario(planned, ["s0", "s1", "s2", "s3"]);
    const state: St[] = planned.map(() => "pending");
    const busy = new Set<string>();

    const dispatched = tickDispatch(planned, state, busy, storage, 4);
    expect(dispatched).toEqual([0, 1, 2]);
    expect(busy.has("s0") && busy.has("s1") && busy.has("s2")).toBe(true);
    expect(busy.has("s3")).toBe(false);
    // Only 3 in flight even though concurrency cap is 4.
    expect(state.filter((s) => s === "running")).toHaveLength(3);
  });

  it("7 scenarios (3 roots + 4 consumers), 4 storages → never more than 3 concurrent (3 unique chains)", () => {
    // Chains:
    //  - postgres/default → zitadel/default          (storage s0)
    //  - postgres/ssl → zitadel/ssl, zitadel/mtls    (storage s1, two consumers)
    //  - postgres/mtls → zitadel/mtls-certonly       (storage s2)
    const planned = plan([
      { id: "postgres/default" },
      { id: "zitadel/default", depends_on: ["postgres/default"] },
      { id: "postgres/ssl" },
      { id: "zitadel/ssl", depends_on: ["postgres/ssl"] },
      { id: "zitadel/mtls", depends_on: ["postgres/ssl"] },
      { id: "postgres/mtls" },
      { id: "zitadel/mtls-certonly", depends_on: ["postgres/mtls"] },
    ]);
    const storage = assignStoragePerScenario(planned, ["s0", "s1", "s2", "s3"]);
    expect(storage.get(0)).toBe("s0");
    expect(storage.get(1)).toBe("s0"); // consumer inherits
    expect(storage.get(2)).toBe("s1");
    expect(storage.get(3)).toBe("s1");
    expect(storage.get(4)).toBe("s1");
    expect(storage.get(5)).toBe("s2");
    expect(storage.get(6)).toBe("s2");

    const state: St[] = planned.map(() => "pending");
    const busy = new Set<string>();

    // Tick 1: 3 roots ready (indices 0, 2, 5). Consumers blocked on deps.
    const tick1 = tickDispatch(planned, state, busy, storage, 4);
    expect(tick1.sort((a, b) => a - b)).toEqual([0, 2, 5]);
    expect(busy.size).toBe(3); // s0, s1, s2 busy; s3 stays idle

    // Mark all 3 roots done; release storage locks.
    for (const i of tick1) { state[i] = "done"; busy.delete(storage.get(i)!); }

    // Tick 2: 4 consumers ready. zitadel/default→s0, zitadel/ssl→s1,
    // zitadel/mtls→s1 (CONFLICT with zitadel/ssl), zitadel/mtls-certonly→s2.
    const tick2 = tickDispatch(planned, state, busy, storage, 4);
    // Three should dispatch; one (the mtls/ssl conflict) must wait.
    expect(tick2.length).toBe(3);
    expect(state.filter((s) => s === "running")).toHaveLength(3);
    // The two zitadel/* sharing s1 must NOT both be running.
    const runningSslChain = state[3] === "running" && state[4] === "running";
    expect(runningSslChain).toBe(false);

    // Finish whoever is on s1 → that slot frees, the waiter joins.
    const onS1Idx = state[3] === "running" ? 3 : 4;
    const waiterIdx = onS1Idx === 3 ? 4 : 3;
    state[onS1Idx] = "done"; busy.delete("s1");
    const tick3 = tickDispatch(planned, state, busy, storage, 4);
    expect(tick3).toEqual([waiterIdx]);
  });

  it("--volume-storage override pins everything → effective concurrency drops to 1", () => {
    const planned = plan([
      { id: "postgres/default" },
      { id: "postgres/ssl" },
      { id: "postgres/mtls" },
    ]);
    const storage = assignStoragePerScenario(planned, ["s0", "s1", "s2"], "pinned");
    const state: St[] = planned.map(() => "pending");
    const busy = new Set<string>();
    const tick = tickDispatch(planned, state, busy, storage, 4);
    // All three want "pinned" → only the first dispatches.
    expect(tick).toEqual([0]);
    expect(state.filter((s) => s === "running")).toHaveLength(1);
  });
});
