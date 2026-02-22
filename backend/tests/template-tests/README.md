# Template Integration Tests

Individual templates (JSON + script) are executed unmocked on the nested Proxmox VM.
Tests are automatically skipped when the host is not reachable.

## Running

```bash
cd backend
pnpm run test:templates
```

## Prerequisites

A running nested Proxmox VM is required. Set it up using the E2E scripts
(see [e2e/README.md](../../../e2e/README.md) for details):

1. **One-time:** Create the custom Proxmox ISO with [e2e/step0-create-iso.sh](../../../e2e/step0-create-iso.sh)
2. **Create the nested VM** with [e2e/step1-create-vm.sh](../../../e2e/step1-create-vm.sh)

```bash
cd e2e
./step0-create-iso.sh   # one-time: build autoinstall ISO
./step1-create-vm.sh    # create nested Proxmox VM (~2 min)
```

Once the VM is running:

- SSH access to the nested VM (default: `root@ubuntupve`, port `1022`)
- Proxmox VE with `pct`, `pveam`, `pvesm` commands available
- Config is read from [e2e/config.json](../../../e2e/config.json)

> **Note:** Step 2 (install deployer) is **not** required for template tests.
> Template tests create their own lightweight containers (VMIDs 9900-9999).

## Architecture

```
tests/template-tests/
  helper/
    global-setup.mts           # Vitest globalSetup: checks SSH + Proxmox, provides hostReachable
    template-test-config.mts   # Config from e2e/config.json + ENV overrides
    template-test-helper.mts   # Script preparation + SSH execution
    test-state-manager.mts     # Container lifecycle (create/start/stop/destroy)
  lxc/                         # Tests for templates that require a container
    wait-for-container-ready.test.mts
```

### Infrastructure Check (globalSetup)

Before any test runs, `global-setup.mts` checks:

1. **SSH connectivity** to the nested VM
2. **Proxmox tools** available (`pveversion`)

The result is provided via Vitest `provide`/`inject`. Tests use
`describe.skipIf(!hostReachable)` to skip automatically — no manual guards needed.

### TemplateTestHelper

Loads template JSON, reads the script, prepends the library, and substitutes
`{{ variables }}` using the production `VariableResolver`.

```typescript
const helper = new TemplateTestHelper(config);

// Execution based on execute_on (ve or lxc)
const result = await helper.runTemplate({
  templatePath: "shared/templates/start/210-wait-for-container-ready.json",
  inputs: { vm_id: "9900" },
  vmId: "9900",        // only required for execute_on: "lxc"
  timeout: 120000,     // optional, default 120s
});

// result.success     - exitCode === 0
// result.outputs     - parsed JSON from stdout (e.g. { ready: "true" })
// result.stdout      - raw stdout
// result.stderr      - raw stderr
// result.exitCode    - exit code
```

For fine-grained control:

```typescript
const { script, executeOn } = helper.prepareScript({
  templatePath: "shared/templates/...",
  commandIndex: 0,     // which command in the template (default: 0)
  inputs: { ... },
});

const result = await helper.executeOnVe(script);
// or
const result = await helper.executeInContainer("9900", script);
```

### TestStateManager

Establishes reproducible container states. All methods are idempotent.

```typescript
const stateManager = new TestStateManager(config);

// Create + start container
await stateManager.ensureContainerRunning("9900", {
  osType: "alpine",       // "alpine" | "debian"
  hostname: "test-ct",    // optional
  memory: 256,            // optional, MB
  storage: "local-zfs",   // optional, auto-detected
});

// Create container but do not start it
await stateManager.ensureContainerCreatedStopped("9900", { ... });

// Start container + wait until responsive (network + package manager)
await stateManager.ensureContainerReady("9900", {
  osType: "alpine",
  timeoutMs: 60000,
});

// Run arbitrary commands on the PVE host
const { stdout, exitCode } = await stateManager.execOnHost("pct list");

// Cleanup
await stateManager.cleanup("9900");
```

OS templates are automatically detected or downloaded via `pveam`.

### VMID Range

Template tests use VMIDs **9900-9999** (no conflict with E2E tests).

## Container Lifecycle States

Each template requires a specific state as precondition:

```
PRE_TEMPLATE_STATE          <- no container needed (list-*, extract-*)
NO_CONTAINER                <- ensureNoContainer()
CONTAINER_CREATED_STOPPED   <- ensureContainerCreatedStopped()
CONTAINER_RUNNING           <- ensureContainerRunning()
CONTAINER_READY             <- ensureContainerReady()
```

## Writing a New Test

```typescript
import { describe, it, inject, beforeAll, afterAll, expect } from "vitest";
import { loadTemplateTestConfig } from "../helper/template-test-config.mjs";
import { TestStateManager } from "../helper/test-state-manager.mjs";
import { TemplateTestHelper } from "../helper/template-test-helper.mjs";

const hostReachable = inject("hostReachable");

describe.skipIf(!hostReachable)("Template: my-template", () => {
  const config = loadTemplateTestConfig();
  const stateManager = new TestStateManager(config);
  const helper = new TemplateTestHelper(config);

  describe("Alpine", () => {
    const vmId = "9902";  // choose a unique VMID!

    beforeAll(async () => {
      await stateManager.ensureContainerReady(vmId, { osType: "alpine" });
    }, 120000);

    afterAll(async () => {
      await stateManager.cleanup(vmId);
    }, 30000);

    it("should do something", async () => {
      const result = await helper.runTemplate({
        templatePath: "shared/templates/post_start/330-post-install-packages.json",
        inputs: { packages: "curl" },
        vmId,
      });

      expect(result.success).toBe(true);

      // Optional: verify the result
      const verify = await stateManager.execOnHost(`pct exec ${vmId} -- which curl`);
      expect(verify.stdout).toContain("curl");
    });
  });
});
```

## Environment Overrides

| Variable | Default | Description |
|----------|---------|-------------|
| `TEMPLATE_TEST_HOST` | from `e2e/config.json` | SSH host |
| `TEMPLATE_TEST_SSH_PORT` | from `e2e/config.json` | SSH port |
| `E2E_INSTANCE` | `default` from config | Config instance |
