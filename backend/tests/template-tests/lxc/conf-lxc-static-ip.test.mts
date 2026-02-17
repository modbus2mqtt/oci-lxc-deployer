import { describe, it, inject, beforeAll, afterAll, expect } from "vitest";
import { loadTemplateTestConfig } from "../helper/template-test-config.mjs";
import { TestStateManager } from "../helper/test-state-manager.mjs";
import { TemplateTestHelper } from "../helper/template-test-helper.mjs";

const hostReachable = inject("hostReachable");

const TEMPLATE_PATH =
  "shared/templates/pre_start/105-conf-set-static-ip-for-lxc.json";

describe.skipIf(!hostReachable)(
  "Template: 105-conf-set-static-ip-for-lxc",
  () => {
    const config = loadTemplateTestConfig();
    const stateManager = new TestStateManager(config);
    const helper = new TemplateTestHelper(config);
    const vmId = "9910";
    const staticIp = "10.255.255.10/24";
    const staticGw = "10.255.255.1";

    beforeAll(async () => {
      await stateManager.ensureContainerCreatedStopped(vmId, {
        osType: "alpine",
        hostname: "tmpl-test-static-ip",
      });
    }, 120000);

    afterAll(async () => {
      await stateManager.cleanup(vmId);
    }, 30000);

    it("should set static IP with host-managed=1 in container config", async () => {
      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          vm_id: vmId,
          hostname: "tmpl-test-static-ip",
          bridge: "vmbr0",
          static_ip: staticIp,
          static_gw: staticGw,
        },
      });

      expect(result.success).toBe(true);
      expect(result.outputs["static_ip_configured"]).toBe("true");

      // Verify the Proxmox config contains host-managed=1
      const confResult = await stateManager.execOnHost(
        `grep 'net0:' /etc/pve/lxc/${vmId}.conf`,
      );
      const net0Line = confResult.stdout.trim();
      expect(net0Line).toContain("host-managed=1");
      expect(net0Line).toContain(`ip=${staticIp}`);
      expect(net0Line).toContain(`gw=${staticGw}`);
    });

    it("should apply IP at namespace level after container start", async () => {
      // Start the container - IP should be configured by LXC without
      // any post-start workaround script
      await stateManager.execOnHost(`pct start ${vmId}`, 30000);

      // Wait briefly for the container to come up
      await new Promise((r) => setTimeout(r, 3000));

      // Check that eth0 has the static IP assigned (via lxc.net.0.ipv4.address)
      const ipResult = await stateManager.execOnHost(
        `pct exec ${vmId} -- ip -4 addr show eth0`,
      );
      expect(ipResult.stdout).toContain("10.255.255.10");
      expect(ipResult.stdout).toMatch(/state UP/);
    }, 60000);

    it("should skip when no static IP provided", async () => {
      // Stop and recreate a clean container for this test
      await stateManager.ensureContainerCreatedStopped(vmId, {
        osType: "alpine",
        hostname: "tmpl-test-static-ip",
      });

      const result = await helper.runTemplate({
        templatePath: TEMPLATE_PATH,
        inputs: {
          vm_id: vmId,
          hostname: "tmpl-test-static-ip",
          bridge: "vmbr0",
        },
      });

      expect(result.success).toBe(true);
      expect(result.outputs["static_ip_configured"]).toBe("skipped");
    }, 120000);
  },
);
