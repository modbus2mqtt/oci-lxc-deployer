import { spawnAsync, type SpawnAsyncResult } from "@src/spawn-utils.mjs";
import type { TemplateTestConfig } from "./template-test-config.mjs";

export class TestStateManager {
  private sshArgs: string[];

  constructor(private config: TemplateTestConfig) {
    this.sshArgs = [
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-p",
      String(config.sshPort),
      `root@${config.host}`,
    ];
  }

  async execOnHost(
    command: string,
    timeout = 30000,
  ): Promise<SpawnAsyncResult> {
    return spawnAsync("ssh", this.sshArgs, { input: command, timeout });
  }

  private async getContainerStatus(
    vmId: string,
  ): Promise<"running" | "stopped" | "absent"> {
    const { stdout, exitCode } = await this.execOnHost(
      `pct status ${vmId} 2>/dev/null`,
    );
    if (exitCode !== 0) return "absent";
    if (stdout.includes("running")) return "running";
    if (stdout.includes("stopped")) return "stopped";
    return "absent";
  }

  async findOsTemplate(osType: "alpine" | "debian"): Promise<string> {
    // Check locally available templates
    const { stdout } = await this.execOnHost("pveam list local");
    const pattern = osType === "alpine" ? /alpine-\d/ : /debian-\d/;
    const lines = stdout.split("\n").filter((l) => pattern.test(l));

    if (lines.length > 0) {
      return lines[lines.length - 1]!.trim().split(/\s+/)[0]!;
    }

    // Download if not available locally
    await this.execOnHost("pveam update", 60000);
    const { stdout: available } = await this.execOnHost(
      `pveam available --section system | grep '${osType}'`,
    );
    const availableLines = available.split("\n").filter((l) => l.trim());

    if (availableLines.length === 0) {
      throw new Error(`No ${osType} template available for download`);
    }

    const templateFile = availableLines[availableLines.length - 1]!
      .trim()
      .split(/\s+/)[1]!;
    await this.execOnHost(`pveam download local ${templateFile}`, 120000);
    return `local:vztmpl/${templateFile}`;
  }

  private async findStorage(): Promise<string> {
    const { stdout } = await this.execOnHost(
      "pvesm status --content rootdir 2>/dev/null | tail -n +2 | awk '{print $1}' | head -1",
    );
    const storage = stdout.trim();
    if (!storage) {
      throw new Error("No storage with rootdir content found");
    }
    return storage;
  }

  async ensureNoContainer(vmId: string): Promise<void> {
    const status = await this.getContainerStatus(vmId);
    if (status === "absent") return;
    if (status === "running") {
      await this.execOnHost(`pct stop ${vmId} --force 1`, 30000);
    }
    await this.execOnHost(`pct destroy ${vmId} --purge 1`, 30000);
  }

  async ensureContainerCreatedStopped(
    vmId: string,
    opts?: {
      hostname?: string;
      osType?: "alpine" | "debian";
      memory?: number;
      storage?: string;
    },
  ): Promise<void> {
    const status = await this.getContainerStatus(vmId);
    if (status === "stopped") return;
    if (status === "running") {
      await this.execOnHost(`pct stop ${vmId} --force 1`, 30000);
      return;
    }

    const osType = opts?.osType || "alpine";
    const hostname = opts?.hostname || `tmpl-test-${osType}`;
    const memory = opts?.memory || 256;
    const storage = opts?.storage || (await this.findStorage());
    const template = await this.findOsTemplate(osType);

    await this.execOnHost(
      `pct create ${vmId} ${template}` +
        ` --hostname ${hostname} --memory ${memory}` +
        ` --rootfs ${storage}:1` +
        ` --net0 name=eth0,bridge=vmbr0,ip=dhcp` +
        ` --unprivileged 1`,
      60000,
    );
  }

  async ensureContainerRunning(
    vmId: string,
    opts?: {
      hostname?: string;
      osType?: "alpine" | "debian";
      memory?: number;
      storage?: string;
    },
  ): Promise<void> {
    const status = await this.getContainerStatus(vmId);
    if (status === "running") return;
    if (status === "absent") {
      await this.ensureContainerCreatedStopped(vmId, opts);
    }
    await this.execOnHost(`pct start ${vmId}`, 30000);
  }

  async ensureContainerReady(
    vmId: string,
    opts?: {
      hostname?: string;
      osType?: "alpine" | "debian";
      memory?: number;
      storage?: string;
      timeoutMs?: number;
    },
  ): Promise<void> {
    await this.ensureContainerRunning(vmId, opts);

    const timeout = opts?.timeoutMs || 60000;
    const start = Date.now();
    const sleep = 3000;

    while (Date.now() - start < timeout) {
      const { exitCode } = await this.execOnHost(
        `pct exec ${vmId} -- sh -c 'hostname -i 2>/dev/null && (apk --version 2>/dev/null || dpkg --version 2>/dev/null || true)'`,
      );
      if (exitCode === 0) return;
      await new Promise((r) => setTimeout(r, sleep));
    }

    throw new Error(`Container ${vmId} not ready within ${timeout}ms`);
  }

  async cleanup(vmId: string): Promise<void> {
    await this.ensureNoContainer(vmId);
  }
}
