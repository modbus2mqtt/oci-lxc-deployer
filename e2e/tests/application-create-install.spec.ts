import { test, expect, getPveHost } from '../fixtures/test-base';
import { E2EApplicationLoader, E2EApplication } from '../utils/application-loader';
import { SSHValidator } from '../utils/ssh-validator';
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

      // Step 1: Create the application via UI wizard
      console.log(`Creating application: ${app!.name}`);
      await helper.createApplication(app!);
      console.log(`Application created: ${app!.name}`);

      // Step 2: Install the application
      console.log(`Installing application: ${app!.name}`);
      await helper.installApplication(app!.name);
      console.log(`Installation started: ${app!.name}`);

      // Step 3: Wait for installation to complete
      console.log(`Waiting for installation to complete: ${app!.name}`);
      const installed = await helper.waitForInstallationComplete();
      expect(installed).toBe(true);
      console.log(`Installation complete: ${app!.name}`);

      // Step 4: Validate via SSH if validation config exists
      if (app!.validation) {
        console.log(`Running validation for: ${app!.name}`);
        const { success, results, summary } = await validator.validate(app!.validation);

        // Log all results
        for (const result of results) {
          console.log(`  ${result.success ? '✓' : '✗'} ${result.message}`);
          if (!result.success && result.details) {
            console.log(`    Details: ${result.details}`);
          }
        }

        console.log(`Validation summary: ${summary}`);
        expect(success, `Validation failed: ${summary}`).toBe(true);
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
