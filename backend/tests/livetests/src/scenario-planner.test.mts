import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyTagFilter,
  classifyRunMode,
  loadScenarioListFromFile,
  loadSnapshotCatalog,
} from "./scenario-planner.mjs";
import { buildAdHocFilter, buildFilter } from "./test-set-registry.mjs";
import type { ResolvedScenario } from "./livetest-types.mjs";

function makeScenarios(
  defs: Record<string, { tags?: string[]; computedTags?: string[]; untestable?: string }>,
): Map<string, ResolvedScenario> {
  const all = new Map<string, ResolvedScenario>();
  for (const [id, def] of Object.entries(defs)) {
    const [app] = id.split("/");
    all.set(id, {
      id,
      application: app!,
      description: `Test ${id}`,
      ...(def.tags ? { tags: def.tags } : {}),
      ...(def.computedTags ? { computedTags: def.computedTags } : {}),
      ...(def.untestable ? { untestable: def.untestable } : {}),
    });
  }
  return all;
}

describe("applyTagFilter", () => {
  it("returns all ids when no filter is provided", () => {
    const all = makeScenarios({
      "a/b": {},
      "c/d": {},
    });
    expect(applyTagFilter(["a/b", "c/d"], all, null)).toEqual(["a/b", "c/d"]);
  });

  it("by default excludes scenarios with `untestable`", () => {
    const all = makeScenarios({
      "a/b": {},
      "c/d": { untestable: "needs audio passthrough" },
    });
    expect(applyTagFilter(["a/b", "c/d"], all, null)).toEqual(["a/b"]);
  });

  it("--include-untestable overrides exclusion", () => {
    const all = makeScenarios({
      "a/b": {},
      "c/d": { untestable: "needs audio passthrough" },
    });
    expect(
      applyTagFilter(["a/b", "c/d"], all, null, { includeUntestable: true }),
    ).toEqual(["a/b", "c/d"]);
  });

  it("matches against the union of declared and computed tags", () => {
    const all = makeScenarios({
      "a/b": { tags: ["cost:quick"], computedTags: ["coverage:critical", "app:a"] },
      "c/d": { computedTags: ["app:c"] },
    });
    const filter = buildAdHocFilter({ includeTags: ["coverage:critical"], excludeTags: [] });
    expect(applyTagFilter(["a/b", "c/d"], all, filter)).toEqual(["a/b"]);
  });

  it("preset-style filter: ci-pr-like behaviour", () => {
    const all = makeScenarios({
      "fast/default": { tags: ["cost:quick"], computedTags: ["coverage:critical"] },
      "slow/default": { tags: ["cost:slow"] },
      "net/quick": { tags: ["cost:quick", "needs:internet"] },
      "prod/default": { computedTags: ["coverage:critical"] },
    });
    const filter = buildFilter({
      tags: ["coverage:critical", "cost:quick"],
      excludeTags: ["needs:*"],
      excludeRegex: ["production"],
    });
    const result = applyTagFilter(
      ["fast/default", "slow/default", "net/quick", "prod/default"],
      all,
      filter,
    );
    expect(result.sort()).toEqual(["fast/default", "prod/default"]);
  });

  it("untestable is enforced even when filter would otherwise include it", () => {
    const all = makeScenarios({
      "a/b": { tags: ["cost:quick"], untestable: "audio" },
      "c/d": { tags: ["cost:quick"] },
    });
    const filter = buildAdHocFilter({ includeTags: ["cost:quick"], excludeTags: [] });
    expect(applyTagFilter(["a/b", "c/d"], all, filter)).toEqual(["c/d"]);
  });
});

describe("classifyRunMode", () => {
  it("`--all` is `all`", () => {
    expect(classifyRunMode("--all", null)).toBe("all");
  });
  it("`@<file>` is `file`", () => {
    expect(classifyRunMode("@e2e/baseline.lst", null)).toBe("file");
  });
  it("snapshotName set wins over everything → `snapshot-build`", () => {
    expect(classifyRunMode("--all", "oidc-base")).toBe("snapshot-build");
    expect(classifyRunMode("zitadel/default", "oidc-base")).toBe("snapshot-build");
  });
  it("plain scenario id is `single`", () => {
    expect(classifyRunMode("zitadel/default", null)).toBe("single");
  });
  it("comma-list without leading @ is `single`", () => {
    expect(classifyRunMode("a/b,c/d", null)).toBe("single");
  });
});

describe("loadSnapshotCatalog", () => {
  function tempRoot(): string {
    return mkdtempSync(path.join(tmpdir(), "snap-catalog-"));
  }
  it("returns empty set when file missing", () => {
    const root = tempRoot();
    expect(loadSnapshotCatalog(root).size).toBe(0);
  });
  it("loads members from a valid file", () => {
    const root = tempRoot();
    mkdirSync(path.join(root, "e2e"), { recursive: true });
    writeFileSync(path.join(root, "e2e/snapshot-catalog.json"),
      JSON.stringify({ members: ["a/b", "c/d"] }));
    expect([...loadSnapshotCatalog(root)].sort()).toEqual(["a/b", "c/d"]);
  });
  it("throws on malformed json shape", () => {
    const root = tempRoot();
    mkdirSync(path.join(root, "e2e"), { recursive: true });
    writeFileSync(path.join(root, "e2e/snapshot-catalog.json"),
      JSON.stringify({ unrelated: true }));
    expect(() => loadSnapshotCatalog(root)).toThrow(/expected \{ members/);
  });
  it("throws on non-string members", () => {
    const root = tempRoot();
    mkdirSync(path.join(root, "e2e"), { recursive: true });
    writeFileSync(path.join(root, "e2e/snapshot-catalog.json"),
      JSON.stringify({ members: ["ok", 42] }));
    expect(() => loadSnapshotCatalog(root)).toThrow(/Invalid snapshot catalog entry/);
  });
});

describe("loadScenarioListFromFile", () => {
  function tempFile(content: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "scenario-list-"));
    const file = path.join(dir, "list.lst");
    writeFileSync(file, content);
    return file;
  }
  it("parses one id per line, returns comma-separated", () => {
    const f = tempFile("a/b\nc/d\n");
    expect(loadScenarioListFromFile(f)).toBe("a/b,c/d");
  });
  it("strips comments and blank lines, trims whitespace", () => {
    const f = tempFile("# header\n  a/b  \n\n# mid-comment\nc/d # trailing\n");
    expect(loadScenarioListFromFile(f)).toBe("a/b,c/d");
  });
  it("preserves order", () => {
    const f = tempFile("z/1\na/2\nm/3\n");
    expect(loadScenarioListFromFile(f)).toBe("z/1,a/2,m/3");
  });
  it("throws on missing file", () => {
    expect(() => loadScenarioListFromFile("/nonexistent/path/foo.lst"))
      .toThrow(/Scenario list file not found/);
  });
  it("throws on empty file", () => {
    const f = tempFile("# only comments\n\n");
    expect(() => loadScenarioListFromFile(f)).toThrow(/empty/);
  });
});
