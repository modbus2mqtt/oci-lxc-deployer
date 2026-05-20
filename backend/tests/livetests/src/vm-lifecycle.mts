/**
 * VM lifecycle management for live integration tests.
 *
 * Handles the three-phase VM preparation:
 * 1. Snapshot restore (rollback to best matching snapshot)
 * 2. Pre-cleanup (reuse running VMs or destroy mismatched ones)
 * 3. Baseline rollback (for --all runs)
 */

import { SnapshotManager } from "./snapshot-manager.mjs";
import { nestedSsh, nestedSshStrict, nestedSshAsync } from "./ssh-helpers.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { PlannedScenario, ResolvedScenario } from "./livetest-types.mjs";
import { logOk, logFail, logWarn, logInfo, logStep } from "./log-helpers.mjs";
import { checkVolumeConsistency } from "./volume-consistency-check.mjs";

/** Tasks that use create_ct + replace_ct (old container must stay running) */
const REPLACE_CT_TASKS = ["upgrade", "reconfigure"];

/**
 * Restore providers from the best-covering per-CT pct snapshot pre-pool.
 *
 * Schritt 3b der konvergierten Architektur: Whole-VM-`qm rollback` ist raus
 * (incompatible mit Parallelisierung); stattdessen wird **jeder Dep-CT mit
 * `pct rollback`** auf den selbstbeschreibend identifizierten Snapshot
 * zurückgesetzt. Container-lokal → andere Cluster bleiben unberührt.
 *
 * `depSnapshotName` darf null sein (z. B. `--all`, Multi-App-Subset): dann
 * findet keine Auflösung statt. Sonst sucht `SnapshotManager.findCoveringSnapshot`
 * den Snapshot, der auf jeder Dep-VMID existiert und dessen `members` den
 * Lauf abdeckt. Build-Hash-Mismatch wird nur geloggt, nicht abgelehnt.
 *
 * Baseline-Reset (qm) gehört nicht hierher — das übernimmt das
 * `--fresh`-Skill außerhalb des Runners.
 */
export async function restoreBestSnapshot(
  planned: PlannedScenario[],
  _allTests: Map<string, ResolvedScenario>,
  config: { pveHost: string; vmId: number; portPveSsh: number; deployerUrl: string; snapshot?: { enabled: boolean } },
  _apiUrl: string,
  projectRoot: string,
  depSnapshotName: string | null,
): Promise<void> {
  // Hinweis: `depSnapshotName` gilt nur für die *Create*-Seite (Phase-0
  // `<app>_deps`-Heuristik bzw. explizit `--snapshot <name>` Build-Modus).
  // Für die RESTORE-Seite scannen wir generell — Schritt 3b: jeder vorhandene
  // selbstbeschreibende pct-Snapshot, dessen `members ⊇ requiredDeps`, ist ein
  // gültiges Restore-Ziel, unabhängig von der CLI-Form. Damit kann ein zuvor
  // gebauter `oidc-base`-Snapshot auch von einem `--all` oder Multi-App-
  // Subset wiederverwendet werden.
  void depSnapshotName;

  // Dep-Steps = die vom Runner als isDependency markierten Plan-Einträge
  // (dependedOn-Logik aus live-test-runner.mts). Vorher wurde versucht über
  // allTests-depends_on zu rekonstruieren — das ist zu breit (zieht das
  // Target ein, wenn es irgendwo sonst Dep ist) und führt dann zu „kein
  // covering snapshot gefunden".
  const depSteps = planned.filter((p) => p.isDependency);
  if (!config.snapshot?.enabled || depSteps.length === 0) return;

  const isLocalDeployer = config.deployerUrl.includes("localhost");
  const localContextPath = isLocalDeployer
    ? path.join(projectRoot, ".livetest-data")
    : undefined;

  let buildHash: string | undefined;
  try {
    const buildInfoPath = path.join(projectRoot, "backend/dist/build-info.json");
    const buildInfo = JSON.parse(readFileSync(buildInfoPath, "utf-8"));
    buildHash = buildInfo.dirty ? `${buildInfo.gitHash}-dirty` : buildInfo.gitHash;
  } catch { /* ignore */ }

  const snapMgr = new SnapshotManager(
    config.pveHost, config.portPveSsh,
    (msg) => logInfo(msg), localContextPath,
  );

  const depVmids = depSteps.map((d) => d.vmId);
  const requiredMembers = depSteps.map((d) => d.scenario.id);
  let chosen: Awaited<ReturnType<typeof snapMgr.findCoveringSnapshot>>;
  try {
    chosen = await snapMgr.findCoveringSnapshot(depVmids, requiredMembers, buildHash);
  } catch (err) {
    logInfo(`Snapshot lookup failed (will install normally): ${err}`);
    return;
  }
  if (!chosen) {
    logInfo(`No pct snapshot covers required deps ${requiredMembers.join(", ")} on VMs ${depVmids.join(", ")} — providers will install fresh`);
    return;
  }

  try {
    logStep("Snapshot", `Restoring per-CT to @${chosen.name} (VMs ${depVmids.join(", ")})`);
    // Roll back each dep CT to the named snapshot in parallel — container-
    // local, no shared state, safe to do concurrently.
    await Promise.all(depVmids.map((vmid) => snapMgr.rollbackCtSnapshot(vmid, chosen!.name)));
    checkVolumeConsistency(
      config.pveHost, config.portPveSsh, projectRoot,
      `pct restore to ${chosen.name}`,
    );

    // Mark all stack-provider steps as already-installed.
    for (const dep of depSteps) {
      dep.skipExecution = true;
    }

    logOk(`Stack providers restored from @${chosen.name}`);
  } catch (err) {
    logInfo(`pct snapshot restore failed, will install normally: ${err}`);
  }
}

/**
 * Janitor: asynchron managed stopped CTs > 1 h post-stop weg­räumen.
 *
 * Consumer-Teardown legt Containers per `pct stop` (kein destroy) ab → 1 h
 * Forensik-Fenster. Beim nächsten Lauf-Start räumt dieser Janitor alle
 * stopped, managed CTs ab, deren Stop-mtime von `/etc/pve/lxc/<vmid>.conf`
 * älter als der TTL ist. Fire-and-forget: blockiert die Test-Ausführung
 * nicht; die `pct destroy`-Aufrufe laufen im Hintergrund weiter, während
 * Phase prepareVms + Stack-Setup + Szenarien starten.
 */
function runJanitorAsync(
  pveHost: string,
  sshPort: number,
  plannedVmIds: ReadonlySet<number>,
  ttlSeconds: number = 3600,
): void {
  void (async () => {
    try {
      // Enumerate stopped CTs and their conf-mtimes. Skip planned VMIDs
      // (those are handled by the existing prepareVms destroy-path).
      const out = await nestedSshAsync(
        pveHost, sshPort,
        `for f in /etc/pve/lxc/*.conf; do ` +
        `  [ -f "$f" ] || continue; ` +
        `  vmid=$(basename "$f" .conf); ` +
        `  st=$(pct status "$vmid" 2>/dev/null | awk '{print $2}'); ` +
        `  [ "$st" = "stopped" ] || continue; ` +
        `  grep -q 'proxvex%3Amanaged\\|proxvex:managed' "$f" 2>/dev/null || continue; ` +
        `  mt=$(stat -c %Y "$f" 2>/dev/null); ` +
        `  [ -n "$mt" ] && echo "$vmid $mt"; ` +
        `done`,
        15000,
      );
      if (!out) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const stale: number[] = [];
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length !== 2) continue;
        const vmid = Number.parseInt(parts[0]!, 10);
        const mtime = Number.parseInt(parts[1]!, 10);
        if (!Number.isFinite(vmid) || !Number.isFinite(mtime)) continue;
        if (plannedVmIds.has(vmid)) continue;
        if (nowSec - mtime <= ttlSeconds) continue;
        stale.push(vmid);
      }
      if (stale.length === 0) return;
      logInfo(`Janitor: ${stale.length} stale stopped CT(s) > ${ttlSeconds}s old → async destroy: ${stale.join(", ")}`);
      // Fire-and-forget destroys (no await on the outer caller); errors
      // logged but never re-thrown to the test pipeline.
      await Promise.all(stale.map(async (vmid) => {
        try {
          await nestedSshAsync(
            pveHost, sshPort,
            `pct destroy ${vmid} --force --purge 2>/dev/null; true`,
            60000,
          );
        } catch (err) {
          logWarn(`Janitor: destroy ${vmid} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }
      }));
      logOk(`Janitor: ${stale.length} CT(s) destroyed`);
    } catch (err) {
      logWarn(`Janitor: enumeration failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
}

/**
 * Pre-test cleanup: smart handling of dependencies vs targets.
 * - Dependencies: reuse if running + managed + correct app/stack, destroy otherwise
 * - Targets: always destroy (unless replace_ct task)
 *
 * Additionally fires a non-blocking janitor pass that destroys managed
 * stopped CTs older than the TTL (1 h post-stop) in the background.
 */
export function prepareVms(
  planned: PlannedScenario[],
  config: { pveHost: string; portPveSsh: number },
  appStacktypes: Map<string, string | string[]>,
): void {
  // Background janitor: managed stopped CTs > 1 h are async-destroyed.
  // Planned VMIDs are skipped (handled below by the synchronous destroy
  // path).
  const plannedVmIds = new Set(planned.map((p) => p.vmId));
  runJanitorAsync(config.pveHost, config.portPveSsh, plannedVmIds);

  for (const p of planned) {
    if (p.skipExecution) continue;

    // Clear stale locks from aborted runs
    try {
      nestedSsh(config.pveHost, config.portPveSsh,
        `pct unlock ${p.vmId} 2>/dev/null; true`, 5000);
    } catch { /* ignore */ }

    let status: string;
    try {
      status = nestedSshStrict(config.pveHost, config.portPveSsh,
        `pct status ${p.vmId} 2>/dev/null || echo "not found"`, 10000);
    } catch (err: any) {
      logFail(`SSH connection failed during pre-cleanup: ${err.message}`);
      process.exit(1);
    }

    const task = p.scenario.task || "installation";
    const isRunning = status.includes("running");
    const isStopped = status.includes("stopped");
    if (p.isDependency && (isRunning || isStopped)) {
      let isManaged = false;
      let matchesApp = false;
      try {
        const notes = nestedSsh(config.pveHost, config.portPveSsh,
          `pct config ${p.vmId} 2>/dev/null | grep -a 'description:' | head -1`, 5000);
        isManaged = /proxvex(%3A|:)managed/.test(notes);
        if (isManaged) {
          const appMatch = notes.match(/application-id\s+(\S+)/);
          const appId = appMatch?.[1]?.replace(/%20/g, " ");
          const rawSt = appStacktypes.get(p.scenario.application);
          const sts = rawSt ? (Array.isArray(rawSt) ? rawSt : [rawSt]) : [];
          const expectedStackId = sts.length > 0 ? `${sts[0]}_${p.stackName}` : p.stackName;
          const stackMatch = notes.match(/stack-id\s+(\S+)/);
          const stackId = stackMatch?.[1]?.replace(/%20/g, " ");
          matchesApp = appId === p.scenario.application && (!stackId || stackId === expectedStackId);
        }
      } catch { /* treat as not managed */ }
      if (isManaged && matchesApp) {
        if (isStopped) {
          logInfo(`Dependency VM ${p.vmId} (${p.scenario.id}) stopped — starting`);
          nestedSsh(config.pveHost, config.portPveSsh,
            `pct start ${p.vmId}`, 30000);
        }
        logOk(`Dependency VM ${p.vmId} (${p.scenario.id}) ${isRunning ? "running" : "started"} — reusing`);
        p.skipExecution = true;
      } else if (isManaged) {
        logInfo(`Dependency VM ${p.vmId} (${p.scenario.id}) running but wrong app/stack — destroying`);
        nestedSsh(config.pveHost, config.portPveSsh,
          `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true`,
          30000);
      } else {
        logInfo(`Dependency VM ${p.vmId} (${p.scenario.id}) running but not managed — destroying`);
        nestedSsh(config.pveHost, config.portPveSsh,
          `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true`,
          30000);
      }
    } else if (REPLACE_CT_TASKS.includes(task) && status.includes("running")) {
      logOk(`VM ${p.vmId} (${p.scenario.id}) running — ${task} in place`);
    } else if (!p.isDependency || status.includes("status:")) {
      logInfo(`Destroying VM ${p.vmId} (${p.scenario.id})...`);
      // Release any leftover host-side LV mounts first — vol_mount
      // (used on LVM/LVM-thin storage) leaves /var/lib/pve-vol-mounts/<volname>
      // mounted on failure paths, and `pct destroy` then fails with
      // "Logical volume contains a filesystem in use". Parse mp volids from
      // the container config before we shut it down.
      nestedSsh(config.pveHost, config.portPveSsh,
        `pct config ${p.vmId} 2>/dev/null | awk '/^mp[0-9]+:/ {sub(/^mp[0-9]+:[[:space:]]+/, ""); n=split($0,a,","); print a[1]}' | while IFS= read -r vid; do ` +
        `  [ -z "$vid" ] && continue; ` +
        `  mnt="/var/lib/pve-vol-mounts/\${vid#*:}"; ` +
        `  mountpoint -q "$mnt" 2>/dev/null && { umount "$mnt" 2>/dev/null || umount -l "$mnt" 2>/dev/null; rmdir "$mnt" 2>/dev/null; }; ` +
        `done; ` +
        `pct stop ${p.vmId} 2>/dev/null || true; pct destroy ${p.vmId} --force --purge 2>/dev/null || true; ` +
        // Sweep orphan LVs from a crashed pct clone / pct destroy. When a
        // reconfigure aborts mid-way, the cloned-and-renamed LV (e.g.
        // vm-224-proxvex-config) survives in LVM but is no longer registered
        // with any container, so the next reconfigure for the same VMID
        // hits "Logical Volume already exists". Match the VMID prefix.
        `command -v lvs >/dev/null 2>&1 && lvs --noheadings -o vg_name,lv_name 2>/dev/null | awk -v vmid=${p.vmId} '$2 ~ "^vm-"vmid"-" {print $1"/"$2}' | xargs -r -n1 lvremove -f >/dev/null 2>&1 || true`,
        30000);
    }

    if (!p.skipExecution && !REPLACE_CT_TASKS.includes(task)) {
      nestedSsh(config.pveHost, config.portPveSsh,
        `find /rpool/data -maxdepth 4 -type d -name ${JSON.stringify(p.hostname)} -path "*/volumes/*" -exec rm -rf {} + 2>/dev/null || true`,
        15000);
    }

    if (!p.skipExecution && !p.isDependency && !REPLACE_CT_TASKS.includes(task)) {
      const verify = nestedSsh(config.pveHost, config.portPveSsh,
        `pct status ${p.vmId} 2>/dev/null || echo "not found"`, 10000);
      if (verify.includes("status:")) {
        logFail(`Failed to destroy VM ${p.vmId} — aborting`);
        process.exit(1);
      }
    }
  }
}
