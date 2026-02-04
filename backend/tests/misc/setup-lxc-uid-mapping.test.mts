import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "child_process";
import { createTestEnvironment, TestEnvironment } from "@tests/helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

describe("setup-lxc-uid-mapping.py", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let subuidPath: string;
  let subgidPath: string;
  let configDir: string;

  beforeEach(async () => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [
        "^shared/scripts/conf-setup-lxc-uid-mapping\\.py$",
        "^shared/scripts/conf-setup-lxc-gid-mapping\\.py$",
        "^shared/scripts/setup_lxc_idmap_common\\.py$",
      ],
    });
    env.initPersistence({ enableCache: false });
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });
    subuidPath = persistenceHelper.resolve(Volume.LocalRoot, "subuid");
    subgidPath = persistenceHelper.resolve(Volume.LocalRoot, "subgid");
    configDir = persistenceHelper.resolve(Volume.LocalRoot, "lxc");
    persistenceHelper.ensureDirSync(Volume.LocalRoot, "lxc");
  });

  afterEach(async () => {
    env.cleanup();
  });

  function runUidScript(uid: string, vmId?: string): { stdout: string; stderr: string; exitCode: number } {
    let scriptContent = persistenceHelper.readTextSync(
      Volume.JsonSharedScripts,
      "conf-setup-lxc-uid-mapping.py",
    );
    scriptContent = scriptContent
      .replace(/\{\{\s*uid\s*\}\}/g, uid)
      .replace(/\{\{\s*vm_id\s*\}\}/g, vmId || "")
      // In case the template contains gid placeholders in comments/legacy text
      .replace(/\{\{\s*gid\s*\}\}/g, "0");

    const commonModule = persistenceHelper.readTextSync(
      Volume.JsonSharedScripts,
      "setup_lxc_idmap_common.py",
    );
    const combined = `${commonModule}\n\n${scriptContent}`;

    const execEnv = {
      ...process.env,
      MOCK_SUBUID_PATH: subuidPath,
      MOCK_CONFIG_DIR: configDir,
      PYTHONPATH: env.rootDir,
    };

    const result = spawnSync("python3", [], {
      input: combined,
      env: execEnv,
      encoding: "utf-8",
      timeout: 5000,
    });

    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.status || 0,
    };
  }

  function runGidScript(gid: string, vmId?: string): { stdout: string; stderr: string; exitCode: number } {
    let scriptContent = persistenceHelper.readTextSync(
      Volume.JsonSharedScripts,
      "conf-setup-lxc-gid-mapping.py",
    );
    scriptContent = scriptContent
      .replace(/\{\{\s*gid\s*\}\}/g, gid)
      .replace(/\{\{\s*vm_id\s*\}\}/g, vmId || "")
      .replace(/\{\{\s*uid\s*\}\}/g, "0");

    const commonModule = persistenceHelper.readTextSync(
      Volume.JsonSharedScripts,
      "setup_lxc_idmap_common.py",
    );
    const combined = `${commonModule}\n\n${scriptContent}`;

    const execEnv = {
      ...process.env,
      MOCK_SUBGID_PATH: subgidPath,
      MOCK_CONFIG_DIR: configDir,
      PYTHONPATH: env.rootDir,
    };

    const result = spawnSync("python3", [], {
      input: combined,
      env: execEnv,
      encoding: "utf-8",
      timeout: 5000,
    });

    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.status || 0,
    };
  }

  it("should configure single UID mapping correctly", () => {
    const resultUid = runUidScript("1000", "100");
    const resultGid = runGidScript("1000", "100");

    expect(resultUid.exitCode).toBe(0);
    expect(resultGid.exitCode).toBe(0);

    // Check /etc/subuid - now simplified: only standard range + passthrough
    const subuidContent = persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "subuid",
    );
    expect(subuidContent).toContain("root:100000:65536"); // Standard range
    expect(subuidContent).toContain("root:1000:1"); // 1:1 passthrough

    // Check /etc/subgid
    const subgidContent = persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "subgid",
    );
    expect(subgidContent).toContain("root:100000:65536");
    expect(subgidContent).toContain("root:1000:1");

    // Check container config - all shifted ranges stay within 100000-165535
    const configContent = persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "lxc/100.conf",
    );
    expect(configContent).toContain("lxc.idmap: u 0 100000 1000");     // Container 0-999 → Host 100000-100999
    expect(configContent).toContain("lxc.idmap: u 1000 1000 1");       // Container 1000 → Host 1000 (passthrough)
    expect(configContent).toContain("lxc.idmap: u 1001 101000 64535"); // Container 1001-65535 → Host 101000+
    expect(configContent).toContain("lxc.idmap: g 0 100000 1000");
    expect(configContent).toContain("lxc.idmap: g 1000 1000 1");
    expect(configContent).toContain("lxc.idmap: g 1001 101000 64535");
  });

  it("should add second UID without duplicating existing entries", () => {
    // First run: UID 1000
    let resultUid = runUidScript("1000", "100");
    let resultGid = runGidScript("1000", "100");
    expect(resultUid.exitCode).toBe(0);
    expect(resultGid.exitCode).toBe(0);

    // Second run: UID 1000,2000
    resultUid = runUidScript("1000,2000", "100");
    resultGid = runGidScript("1000,2000", "100");
    expect(resultUid.exitCode).toBe(0);
    expect(resultGid.exitCode).toBe(0);

    // Check subuid - should have both UIDs but no duplicates
    const subuidContent = persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "subuid",
    );
    const subuidLines = subuidContent.split("\n").filter(l => l.trim());

    // Count occurrences of standard range - should appear only once
    const standardRangeCount = subuidLines.filter(l => l === "root:100000:65536").length;
    expect(standardRangeCount).toBe(1);

    // Simplified subuid: only standard range + passthrough entries
    expect(subuidContent).toContain("root:1000:1");
    expect(subuidContent).toContain("root:2000:1");

    // Check container config - all shifted ranges within standard range
    // For UIDs 1000,2000:
    // - Container 0-999 → Host 100000-100999
    // - Container 1000 → Host 1000 (passthrough)
    // - Container 1001-1999 → Host 101000-101999
    // - Container 2000 → Host 2000 (passthrough)
    // - Container 2001-65535 → Host 102000+
    const configContent = persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "lxc/100.conf",
    );
    expect(configContent).toContain("lxc.idmap: u 0 100000 1000");
    expect(configContent).toContain("lxc.idmap: u 1000 1000 1");
    expect(configContent).toContain("lxc.idmap: u 1001 101000 999");     // Gap between 1000 and 2000
    expect(configContent).toContain("lxc.idmap: u 2000 2000 1");
    expect(configContent).toContain("lxc.idmap: u 2001 101999 63535");   // Rest after 2000

    // No duplicate idmap entries
    const idmapLines = configContent.split("\n").filter(l => l.includes("lxc.idmap:"));
    const uniqueIdmapLines = new Set(idmapLines);
    expect(idmapLines.length).toBe(uniqueIdmapLines.size);
  });

  it("should handle multiple comma-separated UIDs", () => {
    const resultUid = runUidScript("1000,1001,2000", "101");
    const resultGid = runGidScript("1000,1001,2000", "101");
    expect(resultUid.exitCode).toBe(0);
    expect(resultGid.exitCode).toBe(0);

    const configContent = persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "lxc/101.conf",
    );

    // Check all 1:1 mappings are present
    expect(configContent).toContain("lxc.idmap: u 1000 1000 1");
    expect(configContent).toContain("lxc.idmap: u 1001 1001 1");
    expect(configContent).toContain("lxc.idmap: u 2000 2000 1");
    expect(configContent).toContain("lxc.idmap: g 1000 1000 1");
    expect(configContent).toContain("lxc.idmap: g 1001 1001 1");
    expect(configContent).toContain("lxc.idmap: g 2000 2000 1");
  });

  it("should work without vm_id (only update subuid/subgid)", () => {
    const resultUid = runUidScript("1000");
    const resultGid = runGidScript("1000");
    expect(resultUid.exitCode).toBe(0);
    expect(resultGid.exitCode).toBe(0);

    // Files should exist
    expect(persistenceHelper.existsSync(Volume.LocalRoot, "subuid")).toBe(true);
    expect(persistenceHelper.existsSync(Volume.LocalRoot, "subgid")).toBe(true);

    // No config file should be created
    expect(persistenceHelper.existsSync(Volume.LocalRoot, "lxc/100.conf")).toBe(false);
  });

  it("should preserve existing non-idmap entries in container config", () => {
    const existingConfig = `arch: amd64
cores: 2
hostname: test
memory: 512
net0: name=eth0,bridge=vmbr0
ostype: alpine
rootfs: local-lvm:vm-102-disk-0,size=8G
`;
    persistenceHelper.writeTextSync(
      Volume.LocalRoot,
      "lxc/102.conf",
      existingConfig,
    );

    const resultUid = runUidScript("1000", "102");
    const resultGid = runGidScript("1000", "102");
    expect(resultUid.exitCode).toBe(0);
    expect(resultGid.exitCode).toBe(0);

    const configContent = persistenceHelper.readTextSync(
      Volume.LocalRoot,
      "lxc/102.conf",
    );
    
    // Existing entries should be preserved
    expect(configContent).toContain("arch: amd64");
    expect(configContent).toContain("hostname: test");
    expect(configContent).toContain("memory: 512");
    
    // New idmap entries should be added
    expect(configContent).toContain("lxc.idmap: u 1000 1000 1");
  });
});
