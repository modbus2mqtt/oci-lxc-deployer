import { test, expect, getPveHost } from '../fixtures/test-base';
import { E2EApplicationLoader, ValidationConfig } from '../utils/application-loader';
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
 * PostgREST docker-compose E2E Test
 *
 * Tests the docker-compose framework with a real multi-container scenario:
 * 1. Postgres runs as a separate LXC container with static IP
 * 2. PostgREST runs via docker-compose (network_mode: host) connecting to Postgres
 *
 * The test checks if Postgres is already running (from a previous test run)
 * and only installs it if needed.
 */
test.describe('PostgREST docker-compose E2E Test', () => {

  test('install postgres and postgrest, validate connectivity', async ({ page }) => {
    const helper = new ApplicationInstallHelper(page);
    const hostValidator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
    });

    // --- Step 1: Ensure Postgres is running ---
    let postgresAlreadyRunning = false;
    try {
      // Check if port 5432 is reachable on the expected static IP (from PVE host)
      hostValidator.execOnHost(`nc -z ${POSTGRES_HOST} ${POSTGRES_PORT}`);
      postgresAlreadyRunning = true;
      console.log(`Postgres already running on ${POSTGRES_HOST}:${POSTGRES_PORT} - skipping installation`);
    } catch {
      console.log(`Postgres not reachable on ${POSTGRES_HOST}:${POSTGRES_PORT} - will install`);
    }

    if (!postgresAlreadyRunning) {
      const postgresApp = await loader.load('postgres');

      // Cleanup existing postgres application (if any)
      console.log(`Cleaning up existing application: ${postgresApp.applicationId}`);
      const cleanup = helper.cleanupApplication(postgresApp.applicationId);
      console.log(`Cleanup result: ${cleanup.message}`);

      // Create and install postgres with static IP
      console.log('Creating and installing postgres with static IP...');
      await helper.createApplication(postgresApp, { installAfterSave: true });

      const installed = await helper.waitForInstallationComplete(postgresApp.name);
      expect(installed).toBe(true);
      console.log('Postgres installation complete');

      const postgresVmId = await helper.extractCreatedVmId(postgresApp.name);
      expect(postgresVmId, 'Postgres container VMID must be extracted').toBeTruthy();
      console.log(`Postgres container VMID: ${postgresVmId}`);

      // Validate postgres
      if (postgresApp.validation) {
        const postgresValidator = new SSHValidator({
          sshHost: getPveHost(),
          sshPort: SSH_PORT,
          containerVmId: postgresVmId!,
        });

        const { success, summary } = await postgresValidator.validate(postgresApp.validation);
        console.log(`Postgres validation: ${summary}`);
        expect(success, `Postgres validation failed: ${summary}`).toBe(true);
      }
    }

    // --- Step 2: Install PostgREST ---
    const postgrestApp = await loader.load('postgrest');

    // Cleanup existing postgrest application (if any)
    console.log(`Cleaning up existing application: ${postgrestApp.applicationId}`);
    const cleanup = helper.cleanupApplication(postgrestApp.applicationId);
    console.log(`Cleanup result: ${cleanup.message}`);

    // Create and install postgrest with docker-compose framework
    console.log('Creating and installing postgrest (docker-compose framework)...');
    await helper.createApplication(postgrestApp, { installAfterSave: true });

    const installed = await helper.waitForInstallationComplete(postgrestApp.name);
    expect(installed).toBe(true);
    console.log('PostgREST installation complete');

    const postgrestVmId = await helper.extractCreatedVmId(postgrestApp.name);
    expect(postgrestVmId, 'PostgREST container VMID must be extracted').toBeTruthy();
    console.log(`PostgREST container VMID: ${postgrestVmId}`);

    // --- Step 3: Validate PostgREST ---
    const generatedValidation = postgrestApp.dockerCompose
      ? ValidationGenerator.generate({
          dockerComposePath: postgrestApp.dockerCompose,
          waitBeforeValidation: postgrestApp.validation?.waitBeforeValidation,
        })
      : null;

    const validationConfig: ValidationConfig = {
      ...generatedValidation,
      ...postgrestApp.validation,
      containers: [...(generatedValidation?.containers || []), ...(postgrestApp.validation?.containers || [])],
      processes: [...(generatedValidation?.processes || []), ...(postgrestApp.validation?.processes || [])],
      volumes: [...(generatedValidation?.volumes || []), ...(postgrestApp.validation?.volumes || [])],
      ports: [...(generatedValidation?.ports || []), ...(postgrestApp.validation?.ports || [])],
      commands: [...(generatedValidation?.commands || []), ...(postgrestApp.validation?.commands || [])],
      uploadFiles: [...(generatedValidation?.uploadFiles || []), ...(postgrestApp.validation?.uploadFiles || [])],
    };

    validationConfig.containers = deduplicateByKey(validationConfig.containers, 'image');
    validationConfig.processes = deduplicateByKey(validationConfig.processes, 'name');
    validationConfig.volumes = deduplicateByKey(validationConfig.volumes, 'path');
    validationConfig.ports = deduplicateByKey(validationConfig.ports, 'port');
    validationConfig.uploadFiles = deduplicateByKey(validationConfig.uploadFiles, 'path');

    const postgrestValidator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
      containerVmId: postgrestVmId!,
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Validation for: ${postgrestApp.name} (container ${postgrestVmId})`);
    console.log(`${'='.repeat(60)}`);

    const { success, results, summary } = await postgrestValidator.validate(validationConfig);

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
      ? `Validation failed for ${postgrestApp.name}:\n${failed.map((r) => `  - ${r.message}`).join('\n')}`
      : `Validation failed: ${summary}`;

    expect(success, detailedError).toBe(true);
  });
});
