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
    await installAndValidate(page, postgrestApp);
  });

  test('install zitadel', async ({ page }) => {
    const zitadelApp = await loader.load('zitadel');
    await installAndValidate(page, zitadelApp);
  });
});
