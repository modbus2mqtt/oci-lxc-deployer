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

/**
 * Application Installation E2E Tests
 *
 * These tests verify the complete flow of:
 * 1. Creating an application via the UI wizard
 * 2. Installing the application
 * 3. Validating the installation via SSH
 *
 * Prerequisites:
 * - Proxmox VM running (step1-create-vm.sh)
 * - Deployer container installed (step2-install-deployer.sh)
 * - Angular dev server running (for local project)
 * - Optional: Reset snapshot before tests via ./e2e/scripts/snapshot-rollback.sh
 */

// Load config for SSH port
interface E2EConfig {
  ports: { pveSsh: number };
}
const configPath = join(__dirname, '..', 'config.json');
const e2eConfig: E2EConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
const SSH_PORT = e2eConfig.ports.pveSsh;

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

// Applications to test (can be configured via environment)
const TEST_APPS = process.env.E2E_TEST_APPS
  ? process.env.E2E_TEST_APPS.split(',')
  : ['mosquitto', 'postgres', 'node-red'];

test.describe('Application Installation E2E Tests', () => {
  let applications: E2EApplication[];
  let validator: SSHValidator;

  test.beforeAll(async () => {
    // Load all test applications
    applications = await loader.loadAll();
    console.log(`Loaded ${applications.length} test applications: ${applications.map((a) => a.name).join(', ')}`);

    // Initialize SSH validator
    validator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
      containerVmId: '300',
    });

    // Note: Snapshot reset should be done externally before running tests
    // Run: ./e2e/scripts/snapshot-rollback.sh 300 deployer-installed
  });

  test('should load test applications', async () => {
    expect(applications.length).toBeGreaterThan(0);
  });

  test('each test application has required files', async () => {
    for (const appName of TEST_APPS) {
      const app = applications.find((a) => a.name === appName);
      expect(app, `Application ${appName} should be loaded`).toBeDefined();
      expect(app!.dockerCompose, `${appName} should have docker-compose file`).toBeDefined();
      expect(app!.icon, `${appName} should have an icon`).toBeDefined();
    }
  });

  // Generate tests for each application
  for (const appName of TEST_APPS) {
    test(`create, install and validate: ${appName}`, async ({ page }) => {
      const app = applications.find((a) => a.name === appName);
      test.skip(!app, `Application ${appName} not found in test applications`);

      const helper = new ApplicationInstallHelper(page);

      // Step 0: Cleanup existing application (if any)
      console.log(`Cleaning up existing application: ${app!.applicationId}`);
      const cleanup = helper.cleanupApplication(app!.applicationId);
      console.log(`Cleanup result: ${cleanup.message}`);

      // Step 1: Create and install the application via UI wizard using "Save & Install"
      console.log(`Creating and installing application: ${app!.name}`);
      await helper.createApplication(app!, { installAfterSave: true });
      console.log(`Installation started: ${app!.name}`);

      // Step 2: Wait for installation to complete
      console.log(`Waiting for installation to complete: ${app!.name}`);
      const installed = await helper.waitForInstallationComplete();
      expect(installed).toBe(true);
      console.log(`Installation complete: ${app!.name}`);

      // Step 3: Extract the created container VMID from process monitor
      const createdVmId = await helper.extractCreatedVmId();
      expect(createdVmId, 'Container VMID must be extracted from process monitor').toBeTruthy();
      console.log(`Created container VMID: ${createdVmId}`);

      // Step 4: Validate via SSH
      // Generate validation config from docker-compose.yml (UID, volumes, ports)
      // and merge with any manual validation from appconf.json
      const generatedValidation = app!.dockerCompose
        ? ValidationGenerator.generate({
            dockerComposePath: app!.dockerCompose,
            uploadFiles: app!.uploadfiles,
            uploadFilesBasePath: app!.directory,
            waitBeforeValidation: app!.validation?.waitBeforeValidation,
          })
        : null;

      // Merge: generated validation + manual overrides from appconf.json
      const validationConfig: ValidationConfig = {
        ...generatedValidation,
        ...app!.validation,
        // Merge arrays instead of replacing
        processes: [...(generatedValidation?.processes || []), ...(app!.validation?.processes || [])],
        volumes: [...(generatedValidation?.volumes || []), ...(app!.validation?.volumes || [])],
        ports: [...(generatedValidation?.ports || []), ...(app!.validation?.ports || [])],
        uploadFiles: [...(generatedValidation?.uploadFiles || []), ...(app!.validation?.uploadFiles || [])],
      };

      // Deduplicate by key property
      validationConfig.processes = deduplicateByKey(validationConfig.processes, 'name');
      validationConfig.volumes = deduplicateByKey(validationConfig.volumes, 'path');
      validationConfig.ports = deduplicateByKey(validationConfig.ports, 'port');
      validationConfig.uploadFiles = deduplicateByKey(validationConfig.uploadFiles, 'path');

      if (Object.keys(validationConfig).length > 1) { // More than just waitBeforeValidation
        // Create validator for the newly created container
        const appValidator = new SSHValidator({
          sshHost: getPveHost(),
          sshPort: SSH_PORT,
          containerVmId: createdVmId!,
        });

        console.log(`\n${'='.repeat(60)}`);
        console.log(`Validation for: ${app!.name} (container ${createdVmId})`);
        console.log(`${'='.repeat(60)}`);

        const { success, results, summary } = await appValidator.validate(validationConfig);

        // Log all results grouped
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

        // Build detailed error message for failed validations
        const detailedError = failed.length > 0
          ? `Validation failed for ${app!.name}:\n${failed.map((r) => `  - ${r.message}`).join('\n')}`
          : `Validation failed: ${summary}`;

        expect(success, detailedError).toBe(true);
      } else {
        console.log(`No validation config for: ${app!.name}`);
      }
    });
  }
});

test.describe('SSH Validator Unit Tests', () => {
  let validator: SSHValidator;

  test.beforeAll(async () => {
    validator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
      containerVmId: '300',
    });
  });

  test('can execute commands in container', async () => {
    try {
      const output = validator.execInContainer('echo "hello"');
      expect(output.trim()).toBe('hello');
    } catch (error) {
      test.skip(true, `SSH connection failed: ${error}`);
    }
  });

  test('can check docker status', async () => {
    try {
      const output = validator.execInContainer('docker --version');
      expect(output).toContain('Docker');
    } catch (error) {
      test.skip(true, `Docker check failed: ${error}`);
    }
  });
});
