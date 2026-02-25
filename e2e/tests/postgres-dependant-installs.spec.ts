import { test, expect, getPveHost } from '../fixtures/test-base';
import { E2EApplicationLoader, E2EApplication, ValidationConfig } from '../utils/application-loader';
import { SSHValidator } from '../utils/ssh-validator';
import { ValidationGenerator } from '../utils/validation-generator';
import { ApplicationInstallHelper } from '../utils/application-install-helper';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load config for SSH port
interface E2EConfig {
  ports: { pveSsh: number };
  defaults: { deployerStaticIp: string };
}
const configPath = join(__dirname, '..', 'config.json');
const e2eConfig: E2EConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
const SSH_PORT = e2eConfig.ports.pveSsh;

const POSTGRES_HOST = '10.0.0.50';
const POSTGRES_PORT = 5432;

const loader = new E2EApplicationLoader(join(__dirname, '../applications'));

/**
 * Deduplicate array by key property, keeping the last occurrence (manual override wins)
 */
function deduplicateByKey<T>(arr: T[] | undefined, key: keyof T): T[] {
  if (!arr || arr.length === 0) return [];
  const map = new Map<unknown, T>();
  for (const item of arr) {
    map.set(item[key], item);
  }
  return Array.from(map.values());
}

/**
 * Installs an application, validates it, and returns the container VMID.
 */
async function installAndValidate(page: import('@playwright/test').Page, app: E2EApplication): Promise<string> {
  const helper = new ApplicationInstallHelper(page);

  // Cleanup
  console.log(`Cleaning up existing application: ${app.applicationId}`);
  const cleanup = helper.cleanupApplication(app.applicationId);
  console.log(`Cleanup result: ${cleanup.message}`);

  // Install
  console.log(`Creating and installing ${app.name}...`);
  await helper.createApplication(app, { installAfterSave: true });

  const installed = await helper.waitForInstallationComplete(app.name);
  expect(installed).toBe(true);
  console.log(`${app.name} installation complete`);

  const vmId = await helper.extractCreatedVmId(app.name);
  expect(vmId, `${app.name} container VMID must be extracted`).toBeTruthy();
  console.log(`${app.name} container VMID: ${vmId}`);

  // Validate
  const generatedValidation = app.dockerCompose
    ? ValidationGenerator.generate({
        dockerComposePath: app.dockerCompose,
        uploadFiles: app.uploadfiles,
        uploadFilesBasePath: app.directory,
        waitBeforeValidation: app.validation?.waitBeforeValidation,
      })
    : null;

  const validationConfig: ValidationConfig = {
    ...generatedValidation,
    ...app.validation,
    containers: [...(generatedValidation?.containers || []), ...(app.validation?.containers || [])],
    processes: [...(generatedValidation?.processes || []), ...(app.validation?.processes || [])],
    volumes: [...(generatedValidation?.volumes || []), ...(app.validation?.volumes || [])],
    ports: [...(generatedValidation?.ports || []), ...(app.validation?.ports || [])],
    commands: [...(generatedValidation?.commands || []), ...(app.validation?.commands || [])],
    uploadFiles: [...(generatedValidation?.uploadFiles || []), ...(app.validation?.uploadFiles || [])],
  };

  validationConfig.containers = deduplicateByKey(validationConfig.containers, 'image');
  validationConfig.processes = deduplicateByKey(validationConfig.processes, 'name');
  validationConfig.volumes = deduplicateByKey(validationConfig.volumes, 'path');
  validationConfig.ports = deduplicateByKey(validationConfig.ports, 'port');
  validationConfig.uploadFiles = deduplicateByKey(validationConfig.uploadFiles, 'path');

  const appValidator = new SSHValidator({
    sshHost: getPveHost(),
    sshPort: SSH_PORT,
    containerVmId: vmId!,
  });

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Validation for: ${app.name} (container ${vmId})`);
  console.log(`${'='.repeat(60)}`);

  const { success, results, summary } = await appValidator.validate(validationConfig);

  const passed = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  if (passed.length > 0) {
    console.log(`\n✓ Passed (${passed.length}):`);
    for (const result of passed) {
      console.log(`  ✓ ${result.message}`);
    }
  }

  if (failed.length > 0) {
    console.log(`\n✗ Failed (${failed.length}):`);
    for (const result of failed) {
      console.log(`  ✗ ${result.message}`);
      if (result.details) {
        console.log(`    Details: ${result.details.substring(0, 200)}`);
      }
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Summary: ${summary}`);
  console.log(`${'─'.repeat(60)}\n`);

  const detailedError = failed.length > 0
    ? `Validation failed for ${app.name}:\n${failed.map((r) => `  - ${r.message}`).join('\n')}`
    : `Validation failed: ${summary}`;

  expect(success, detailedError).toBe(true);

  return vmId!;
}

/**
 * Postgres-dependent docker-compose E2E Tests
 *
 * Tests docker-compose applications that depend on a shared Postgres instance:
 * 1. Ensures Postgres is running (installs only if not reachable)
 * 2. PostgREST and Zitadel are installed and validated independently
 */
test.describe('Postgres-dependent docker-compose E2E Tests', () => {

  test('install postgres', async ({ page }) => {
    const hostValidator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
    });

    // Destroy ALL existing postgres containers + clean volume data
    // '0' as keepVmId means no container is kept (destroy all matching)
    const cleanupResult = hostValidator.cleanupOldContainers(
      'postgres',
      '0',
      e2eConfig.defaults.deployerStaticIp,
    );
    console.log(`Postgres cleanup: ${cleanupResult.message}`);

    // Install postgres (without immediate validation - initdb on fresh volume takes time)
    const postgresApp = await loader.load('postgres');
    const helper = new ApplicationInstallHelper(page);

    console.log(`Cleaning up existing application: ${postgresApp.applicationId}`);
    const cleanup = helper.cleanupApplication(postgresApp.applicationId);
    console.log(`Cleanup result: ${cleanup.message}`);

    console.log(`Creating and installing ${postgresApp.name}...`);
    await helper.createApplication(postgresApp, { installAfterSave: true });

    const installed = await helper.waitForInstallationComplete(postgresApp.name);
    expect(installed).toBe(true);

    const vmId = await helper.extractCreatedVmId(postgresApp.name);
    expect(vmId, 'Postgres container VMID must be extracted').toBeTruthy();
    console.log(`Postgres container VMID: ${vmId}`);

    // Poll for postgres readiness every second (initdb on fresh volume needs time)
    console.log('Waiting for postgres to accept connections...');
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        hostValidator.execOnHost(`nc -z ${POSTGRES_HOST} ${POSTGRES_PORT}`);
        ready = true;
        console.log(`Postgres ready after ${i + 1}s`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(ready, 'Postgres not ready after 60s').toBe(true);
  });

  test('ensure postgres is running', async ({ page }) => {
    const hostValidator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
    });

    try {
      hostValidator.execOnHost(`nc -z ${POSTGRES_HOST} ${POSTGRES_PORT}`);
      console.log(`Postgres already running on ${POSTGRES_HOST}:${POSTGRES_PORT}`);
      return;
    } catch {
      console.log(`Postgres not reachable on ${POSTGRES_HOST}:${POSTGRES_PORT} - installing...`);
    }

    const postgresApp = await loader.load('postgres');
    await installAndValidate(page, postgresApp);
  });

  test('install postgrest', async ({ page }) => {
    const postgrestApp = await loader.load('postgrest');
    const vmId = await installAndValidate(page, postgrestApp);

    // --- PostgREST API end-to-end query ---
    console.log('\n--- PostgREST API Query Verification ---');

    const postgrestValidator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
      containerVmId: vmId,
    });

    // Install postgresql-client in the PostgREST LXC for table setup
    console.log('Installing postgresql-client...');
    postgrestValidator.execInContainer('apk add --no-cache postgresql-client', 60000);

    // Extract DB URI from running PostgREST container environment
    console.log('Extracting DB connection from PostgREST container...');
    const dbUri = postgrestValidator.execInContainer(
      [
        'PGRST_CID=$(docker ps -q --filter ancestor=postgrest/postgrest | head -1)',
        "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' $PGRST_CID | grep ^PGRST_DB_URI= | cut -d= -f2-",
      ].join(' && ')
    ).trim();
    expect(dbUri, 'PostgREST DB URI must be extractable').toBeTruthy();
    console.log('DB URI extracted successfully');

    // Create test table, insert data, and notify PostgREST to reload schema
    console.log('Creating test table and inserting data...');
    postgrestValidator.execInContainer(
      `psql '${dbUri}' -c "CREATE TABLE IF NOT EXISTS e2e_test (id serial PRIMARY KEY, name text NOT NULL); INSERT INTO e2e_test (name) SELECT 'postgrest-works' WHERE NOT EXISTS (SELECT 1 FROM e2e_test WHERE name = 'postgrest-works'); NOTIFY pgrst, 'reload schema';"`,
      15000
    );
    console.log('Test table created and schema reload triggered');

    // Wait for PostgREST to pick up schema change
    console.log('Waiting for PostgREST schema reload...');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Query the test table through PostgREST REST API
    // Note: use 127.0.0.1 instead of localhost — Alpine wget tries IPv6 first,
    // but PostgREST only listens on IPv4
    console.log('Querying PostgREST API...');
    const apiResponse = postgrestValidator.execInContainer(
      "wget -qO- 'http://127.0.0.1:3000/e2e_test?select=name&limit=1'"
    );
    console.log(`PostgREST API response: ${apiResponse}`);
    expect(apiResponse).toContain('postgrest-works');
    console.log('PostgREST API query verification passed!');

    // Cleanup old containers with same hostname (from previous test runs)
    const hostValidator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
    });
    hostValidator.cleanupOldContainers(
      postgrestApp.applicationId,
      vmId,
      e2eConfig.defaults.deployerStaticIp,
    );
  });

  test('reset zitadel database', async () => {
    const hostValidator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
    });

    // Find postgres container VMID and verify it's running
    // Must match hostname exactly to avoid matching "postgrest" etc.
    const pctOutput = hostValidator.execOnHost('pct list').trim();
    const postgresLine = pctOutput.split('\n').find((line) => {
      const parts = line.trim().split(/\s+/);
      const hostname = parts[parts.length - 1]; // hostname is always the last column
      const status = parts[1];
      return hostname === 'postgres' && status?.toLowerCase() === 'running';
    });

    if (!postgresLine) {
      const allLines = pctOutput.split('\n').filter((l) => {
        const parts = l.trim().split(/\s+/);
        return parts[parts.length - 1] === 'postgres';
      });
      const status = allLines.length > 0 ? allLines[0].trim() : 'not found';
      throw new Error(`Postgres container not running. Status: ${status}`);
    }

    const postgresVmId = postgresLine.trim().split(/\s+/)[0];
    console.log(`Found running postgres container: VMID ${postgresVmId}`);

    // Terminate active connections and drop zitadel database + roles for a clean start-from-init
    try {
      hostValidator.execOnHost(
        `pct exec ${postgresVmId} -- /usr/local/bin/psql -U postgres -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'zitadel';"`
      );
    } catch {
      // No active connections - OK
    }

    try {
      hostValidator.execOnHost(
        `pct exec ${postgresVmId} -- /usr/local/bin/psql -U postgres -c 'DROP DATABASE IF EXISTS zitadel;'`
      );
      console.log('Dropped zitadel database');
    } catch (e) {
      throw new Error(`Failed to drop zitadel database on container ${postgresVmId}: ${e}`);
    }

    // Clean up Zitadel-created roles (may not exist on first run)
    for (const role of ['zitadel', 'zitadel_admin']) {
      try {
        hostValidator.execOnHost(
          `pct exec ${postgresVmId} -- /usr/local/bin/psql -U postgres -c "REASSIGN OWNED BY ${role} TO postgres; DROP OWNED BY ${role} CASCADE; DROP ROLE ${role};"`
        );
        console.log(`Dropped role: ${role}`);
      } catch {
        // Role doesn't exist - OK
      }
    }
  });

  test('install zitadel', async ({ page }) => {
    const zitadelApp = await loader.load('zitadel');
    const helper = new ApplicationInstallHelper(page);

    console.log(`Cleaning up existing application: ${zitadelApp.applicationId}`);
    const cleanup = helper.cleanupApplication(zitadelApp.applicationId);
    console.log(`Cleanup result: ${cleanup.message}`);

    console.log(`Creating and installing ${zitadelApp.name}...`);
    await helper.createApplication(zitadelApp, { installAfterSave: true });

    const installed = await helper.waitForInstallationComplete(zitadelApp.name);
    expect(installed).toBe(true);

    const vmId = await helper.extractCreatedVmId(zitadelApp.name);
    expect(vmId, 'Zitadel container VMID must be extracted').toBeTruthy();
    console.log(`Zitadel container VMID: ${vmId}`);

    // Poll for zitadel readiness every second (start-from-init initializes DB schema)
    const hostValidator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
      containerVmId: vmId!,
    });

    console.log('Waiting for zitadel to accept connections on port 8080...');
    let ready = false;
    for (let i = 0; i < 180; i++) {
      try {
        hostValidator.execOnHost(`IP=$(lxc-info -n ${vmId} -iH | head -1) && nc -z $IP 8080`);
        ready = true;
        console.log(`Zitadel ready after ${i + 1}s`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    expect(ready, 'Zitadel not ready after 180s').toBe(true);

    // Cleanup old containers with same hostname (from previous test runs)
    hostValidator.cleanupOldContainers(
      zitadelApp.applicationId,
      vmId!,
      e2eConfig.defaults.deployerStaticIp,
    );
  });
});
