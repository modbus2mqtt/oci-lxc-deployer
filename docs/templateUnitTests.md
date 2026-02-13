# Plan: Template Integration Tests (unmocked, auf nested VM)

## Context

Templates (JSON + Scripts) sind das Herzstück des OCI LXC Deployers. Aktuell gibt es:
- **Unit-Tests** mit `ExecutionMode.TEST` - testen Variable-Substitution und Output-Parsing, aber nicht die Scripts selbst
- **Live-Tests** (`run-live-test.sh`) - testen den gesamten Deployment-Workflow end-to-end, aber nicht einzelne Templates

**Ziel:** Leichtgewichtiger `TemplateTestHelper` + **State-basierte Test-Fixture-Helpers**, um einzelne Templates (auch komplexe!) unmocked auf der nested VM auszuführen. Proof of Concept mit 2-3 Beispieltests auf verschiedenen State-Leveln.

## Container-Lifecycle-States

Die Analyse aller ~50 Templates ergibt 8 distinkte States, die als Preconditions dienen:

```
PRE_TEMPLATE_STATE (Proxmox Host)
  │
  ├── list-*, 010, 011, 095, 096, 120, 121, 310-extract, 315-extract, 900
  │
  ▼
NO_CONTAINER
  │  ← 100 (conf-create-configure-lxc) erstellt Container
  ▼
CONTAINER_CREATED_STOPPED
  │  ← 101, 104-107, 110-112, 150, 155, 160, 170, 190 konfigurieren
  │  ← 200 (start-lxc) startet
  ▼
CONTAINER_RUNNING
  │  ← 210 (wait-for-container-ready) wartet
  ▼
CONTAINER_READY
  │  ← 300, 305, 307, 310, 320, 330, 335, 340, 350 installieren
  ▼
CONTAINER_WITH_DOCKER (optional, ab 307)
  │  ← 330 (docker-compose up)
  ▼
FULLY_PROVISIONED
```

**Spezial-States:**
- `CONTAINER_WITH_VOLUMES` - Storage Volumes erstellt/angehängt (150, 155, 160)
- `CONTAINER_DOCKER_ENABLED` - Config für Docker modifiziert (101)

## Template-zu-State-Zuordnung (alle ~50 Templates)

| Required State | Templates (Anzahl) | Beispiele |
|---------------|-------------------|-----------|
| PRE_TEMPLATE_STATE | 16 | list-storage, get-oci-image, kernel-modules, extract-compose |
| NO_CONTAINER | 1 | conf-create-configure-lxc (100) |
| CONTAINER_CREATED_STOPPED | 14 | conf-docker, static-ip, map-devices, volumes, env-vars, notes |
| CONTAINER_RUNNING | 4 | stop-lxc, wait-for-ready, copy-upgrade |
| CONTAINER_READY | 12 | install-packages, create-user, create-service, samba |
| CONTAINER_WITH_DOCKER | 2 | docker-compose-upload, docker-compose-start |
| External Services | 2 | provision-postgres, import-node-red-flow |

**Ergebnis:** Mit 6 State-Helpers sind ~49 von ~52 Templates einzeln testbar (3 externe).

## Architektur

### Leichtgewichtiger SSH-basierter Helper + State Manager

```
TestStateManager                          TemplateTestHelper
  ├── ensurePreTemplateState()              ├── prepareScript(templatePath, inputs)
  ├── ensureNoContainer(vmId)               ├── executeOnVe(script)
  ├── ensureContainerCreatedStopped(vmId)   ├── executeInContainer(vmId, script)
  ├── ensureContainerRunning(vmId)          ├── runTemplate(opts)
  ├── ensureContainerReady(vmId)            └── parseOutputs(stdout)
  ├── ensureContainerWithVolumes(vmId)
  ├── ensureDockerEnabled(vmId)
  └── cleanup(vmId)
```

Der `TestStateManager` stellt reproduzierbare States her. Der `TemplateTestHelper` führt Templates aus.

## Vorhandene Infrastruktur (wird wiederverwendet)

| Komponente | Pfad | Nutzung |
|-----------|------|---------|
| E2E Config | `e2e/config.json` | Host `ubuntupve`, Port `1022` |
| SSHValidator Pattern | `e2e/utils/ssh-validator.ts` | Vorbild für SSH-Execution |
| spawnAsync | `backend/src/spawn-utils.mts` | Async Process-Ausführung |
| pkg-common.sh | `json/shared/scripts/library/pkg-common.sh` | Library für Paket-Scripts |

## Neue Dateien

```
backend/
  vitest.config.template-tests.mts
  tests/template-tests/
    helper/
      template-test-config.mts          # Config aus e2e/config.json
      template-test-helper.mts          # Script-Loading + SSH-Execution
      test-state-manager.mts            # State-Helpers (8 States)
    ve/
      list-storage.test.mts             # Beispiel: PRE_TEMPLATE_STATE
    lxc/
      post-install-packages.test.mts    # Beispiel: CONTAINER_READY
      conf-set-env-vars.test.mts        # Beispiel: CONTAINER_CREATED_STOPPED
```

`package.json` erhält neues Script: `"test:templates"`

## Implementierungsschritte

### 1. Vitest-Konfiguration
**Datei:** `backend/vitest.config.template-tests.mts`
- Basiert auf `vitest.config.base.mts`
- Pattern: `tests/template-tests/**/*.test.mts`
- Timeout: 120000ms
- Script in `package.json`: `"test:templates": "vitest run --config vitest.config.template-tests.mts"`

### 2. Template-Test-Config
**Datei:** `backend/tests/template-tests/helper/template-test-config.mts`

```typescript
export interface TemplateTestConfig {
  host: string;      // "ubuntupve"
  sshPort: number;   // 1022
  repoRoot: string;  // Projekt-Root für json/ und scripts/
}

/** Liest Config aus e2e/config.json, ENV-Overrides möglich */
export function loadTemplateTestConfig(): TemplateTestConfig

/** Prüft SSH-Erreichbarkeit, cached Ergebnis */
export async function isTestHostReachable(config: TemplateTestConfig): Promise<boolean>

/** Vitest-Helper: skippt Test wenn Host nicht erreichbar */
export async function skipIfHostUnreachable(config: TemplateTestConfig): Promise<void>
```

### 3. TestStateManager (Kern-Innovation)
**Datei:** `backend/tests/template-tests/helper/test-state-manager.mts`

```typescript
export class TestStateManager {
  constructor(private config: TemplateTestConfig)

  /** SSH-Kommando auf VE-Host ausführen */
  async execOnHost(command: string): Promise<{ stdout: string; exitCode: number }>

  // === State Helpers ===

  /** Sicherstellen: Proxmox erreichbar, pct/pvesh verfügbar */
  async ensurePreTemplateState(): Promise<void>

  /** Container existiert nicht (destroy falls nötig) */
  async ensureNoContainer(vmId: string): Promise<void>

  /** Minimalen Alpine-Container erstellt + gestoppt.
   *  Idempotent: destroyed + re-created falls bereits vorhanden. */
  async ensureContainerCreatedStopped(vmId: string, opts?: {
    hostname?: string;
    storage?: string;      // default: erste verfügbare
    memory?: number;       // default: 256
    templatePath?: string; // default: Alpine latest
  }): Promise<void>

  /** Container läuft (erstellt + startet falls nötig) */
  async ensureContainerRunning(vmId: string): Promise<void>

  /** Container läuft + ist responsive (lxc-attach + pkg mgr) */
  async ensureContainerReady(vmId: string, opts?: {
    timeoutMs?: number;  // default: 60000
  }): Promise<void>

  /** Container hat Storage Volumes attached */
  async ensureContainerWithVolumes(vmId: string, opts: {
    volumes: string[];    // z.B. ["data", "config"]
    storage?: string;
  }): Promise<{ volumesAttached: string; sharedVolpath: string }>

  /** Container-Config für Docker modifiziert */
  async ensureDockerEnabled(vmId: string): Promise<void>

  // === Cleanup ===

  /** Container stoppen + zerstören */
  async cleanup(vmId: string): Promise<void>
}
```

**State-Helper-Implementierung** (via SSH auf nested VM):
- `ensureContainerCreatedStopped`: `pct create <vmid> <template> --hostname ... && pct stop <vmid>`
- `ensureContainerRunning`: `pct start <vmid>` + polling `pct status`
- `ensureContainerReady`: Polling mit `pct exec <vmid> -- sh -c "hostname -i && apk --version"`
- `ensureDockerEnabled`: Schreibt lxc.cgroup2/lxc.apparmor Config-Zeilen
- Jeder Helper ist idempotent: prüft aktuellen State, macht nur was nötig ist

**VMID-Bereich:** 9900-9999 für Template-Tests (kein Konflikt mit E2E-Tests).

### 4. TemplateTestHelper
**Datei:** `backend/tests/template-tests/helper/template-test-helper.mts`

```typescript
export interface TemplateTestResult {
  success: boolean;
  outputs: Record<string, string | number | boolean>;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class TemplateTestHelper {
  constructor(private config: TemplateTestConfig)

  /** Lädt Template JSON, Script, Library. Substituiert Variablen. */
  prepareScript(opts: {
    templatePath: string;
    commandIndex?: number;  // default: 0 (erster Command)
    inputs?: Record<string, string | number | boolean>;
  }): { script: string; interpreter?: string[]; executeOn: string }

  /** Führt Script auf VE-Host aus */
  async executeOnVe(script: string, interpreter?: string[]): Promise<TemplateTestResult>

  /** Führt Script in Container aus */
  async executeInContainer(vmId: string, script: string, interpreter?: string[]): Promise<TemplateTestResult>

  /** Convenience: prepareScript + execute basierend auf execute_on */
  async runTemplate(opts: {
    templatePath: string;
    commandIndex?: number;
    inputs?: Record<string, string | number | boolean>;
    vmId?: string;
  }): Promise<TemplateTestResult>
}
```

**Script-Vorbereitung:**
1. Template JSON lesen aus `json/` relativ zu `repoRoot`
2. Script lesen aus passendem `scripts/` Verzeichnis
3. Library prependen falls definiert (aus `json/shared/scripts/library/`)
4. Interpreter aus Shebang extrahieren
5. `{{ variable }}` ersetzen (einfaches Regex, analog zu `VariableResolver`)

**SSH-Ausführung** (analog `SSHValidator`):
- VE: `spawnAsync("ssh", ["-p", sshPort, "-o", "StrictHostKeyChecking=no", ...], { input: script })`
- LXC: `ssh ... "pct exec <vmid> sh"` mit Script via stdin
- JSON-Marker für Output-Extraktion
- Parst JSON aus stdout

### 5. Beispieltest: PRE_TEMPLATE_STATE (VE)
**Datei:** `backend/tests/template-tests/ve/list-storage.test.mts`

Testet `list/list-available-storage.json` - benötigt nur SSH zur nested VM.

```typescript
describe("Template: list-available-storage", () => {
  it("should return enumValues with available storage", async () => {
    const result = await helper.runTemplate({
      templatePath: "shared/templates/list/list-available-storage.json",
    });
    expect(result.success).toBe(true);
    expect(result.outputs).toHaveProperty("enumValues");
  });
});
```

### 6. Beispieltest: CONTAINER_CREATED_STOPPED (VE mit Container)
**Datei:** `backend/tests/template-tests/lxc/conf-set-env-vars.test.mts`

Testet `pre_start/170-conf-set-environment-variables-in-lxc.json` - benötigt gestoppten Container.

```typescript
describe("Template: conf-set-environment-variables", () => {
  const vmId = "9901";
  let stateManager: TestStateManager;

  beforeAll(async () => {
    await stateManager.ensureContainerCreatedStopped(vmId, { hostname: "env-test" });
  }, 60000);
  afterAll(async () => { await stateManager.cleanup(vmId); }, 30000);

  it("should set environment variables in container config", async () => {
    const result = await helper.runTemplate({
      templatePath: "shared/templates/pre_start/170-conf-set-environment-variables-in-lxc.json",
      inputs: { vm_id: vmId, envs: "FOO=bar\nBAZ=qux" },
    });
    expect(result.success).toBe(true);

    // Verifiziere: Config enthält lxc.environment
    const config = await stateManager.execOnHost(`pct config ${vmId}`);
    expect(config.stdout).toContain("FOO=bar");
  });
});
```

### 7. Beispieltest: CONTAINER_READY (LXC)
**Datei:** `backend/tests/template-tests/lxc/post-install-packages.test.mts`

Testet `post_start/330-post-install-packages.json` - benötigt laufenden, responsiven Container.

```typescript
describe("Template: post-install-packages", () => {
  const vmId = "9902";

  beforeAll(async () => {
    await stateManager.ensureContainerReady(vmId);
  }, 90000);
  afterAll(async () => { await stateManager.cleanup(vmId); }, 30000);

  it("should install curl package via apk", async () => {
    const result = await helper.runTemplate({
      templatePath: "shared/templates/post_start/330-post-install-packages.json",
      inputs: { packages: "curl" },
      vmId,
    });
    expect(result.success).toBe(true);

    // Verifiziere: curl ist installiert
    const verify = await stateManager.execOnHost(`pct exec ${vmId} -- which curl`);
    expect(verify.stdout.trim()).toContain("curl");
  });
});
```

## Testbarkeits-Übersicht (mit State-Helpers)

| Required State | Testbar | Anzahl | Helper |
|---------------|---------|--------|--------|
| PRE_TEMPLATE_STATE | Ja | 16 | `ensurePreTemplateState()` |
| NO_CONTAINER | Ja | 1 | `ensureNoContainer()` |
| CONTAINER_CREATED_STOPPED | Ja | 14 | `ensureContainerCreatedStopped()` |
| CONTAINER_RUNNING | Ja | 4 | `ensureContainerRunning()` |
| CONTAINER_READY | Ja | 12 | `ensureContainerReady()` |
| WITH_DOCKER | Ja | 2 | `ensureDockerEnabled()` |
| WITH_VOLUMES | Ja | 3 | `ensureContainerWithVolumes()` |
| External Services | Nein | 2 | (postgres, node-red) |
| **Total testbar** | | **~50 von 52** | |

## Verifizierung

1. `ssh -p 1022 root@ubuntupve echo ok` - Nested VM erreichbar
2. `cd backend && pnpm run lint:fix && pnpm run build` - Kompiliert
3. `cd backend && pnpm run test:templates` - Template-Tests laufen
4. Tests skippen sauber wenn Host nicht erreichbar
5. VE-Test: list-storage liefert gültigen Output (PRE_TEMPLATE_STATE)
6. Config-Test: env-vars werden in Container-Config geschrieben (CONTAINER_CREATED_STOPPED)
7. LXC-Test: curl wird installiert (CONTAINER_READY)
8. Cleanup: Alle Test-Container (9900+) werden aufgeräumt
