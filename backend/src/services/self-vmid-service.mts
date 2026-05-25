import { readFile } from "node:fs/promises";
import { createLogger } from "../logger/index.mjs";

const logger = createLogger("self-vmid");

let cached: string | null = null;

/**
 * Detect the LXC VMID this backend process is currently running inside.
 *
 * Method: read /proc/1/cgroup and extract the `lxc/<vmid>/` path component.
 * Works in both privileged and unprivileged Proxmox LXC containers — the
 * container's view of cgroup paths always includes its own LXC slice.
 *
 * Cached in-memory after first successful read; the vmid never changes for
 * the lifetime of a process. Returns null if the detection fails (running
 * outside an LXC, or unexpected cgroup format) — caller is expected to
 * handle that case (typically: require an explicit previous_vm_id).
 *
 * Used by `shouldOrchestrateSelfUpgrade` so a POST to /api/.../upgrade
 * without explicit `previous_vm_id` still triggers orchestration when the
 * Hub itself is the deployer-instance being upgraded.
 */
export async function getSelfVmid(): Promise<string | null> {
  if (cached !== null) return cached;
  try {
    const content = await readFile("/proc/1/cgroup", "utf-8");
    // cgroup v2 unified: `0::/lxc.payload.<vmid>/...` or `0::/lxc/<vmid>/...`
    // cgroup v1 (named): `<n>:<ctrl>:/lxc/<vmid>/...`
    // Match either form by looking for `lxc[.payload]?/<digits>` anywhere.
    const m = content.match(/lxc(?:\.payload)?[./]([0-9]+)\b/);
    if (m && m[1]) {
      cached = m[1];
      logger.info("self-vmid detected via /proc/1/cgroup", { selfVmid: cached });
      return cached;
    }
    logger.warn("self-vmid: /proc/1/cgroup has no lxc/<vmid> component (running outside LXC?)", {
      cgroupSample: content.split("\n").slice(0, 3).join(" | "),
    });
    return null;
  } catch (err: any) {
    logger.warn("self-vmid detection failed", { error: err?.message ?? String(err) });
    return null;
  }
}
