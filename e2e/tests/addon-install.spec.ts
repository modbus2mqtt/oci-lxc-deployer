import { test, expect, getPveHost } from '../fixtures/test-base';
import { E2EApplicationLoader, E2EApplication } from '../utils/application-loader';
import { SSHValidator } from '../utils/ssh-validator';
import { ApplicationInstallHelper } from '../utils/application-install-helper';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Addon Installation E2E Tests
 *
 * These tests verify the flow of:
 * 1. Creating a base application (node-red) via wizard
 * 2. Installing it with an addon (samba-shares)
 * 3. Validating the addon installation via SSH
 *
 * Prerequisites:
 * - Proxmox VM running (step1-create-vm.sh)
 * - Deployer container installed (step2-install-deployer.sh)
 * - Angular dev server running
 */

// Load config for SSH port
interface E2EConfig {
  ports: { pveSsh: number };
}
const configPath = join(__dirname, '..', 'config.json');
const e2eConfig: E2EConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
const SSH_PORT = e2eConfig.ports.pveSsh;

// Addon test configuration
interface AddonTestConfig {
  name: string;
  description: string;
  baseApplication: string;
  addon: string;
  addonParams: Record<string, string>;
  addonFiles?: Record<string, string>;
  validation: {
    waitBeforeValidation?: number;
    processes?: Array<{ name: string; description?: string }>;
    ports?: Array<{ port: number; protocol?: string; service?: string }>;
    files?: Array<{ path: string; contentPattern?: string }>;
    commands?: Array<{ command: string; expectedOutput?: string; description?: string }>;
  };
}

/**
 * Load addon test configuration from appconf.json
 */
function loadAddonConfig(addonName: string): AddonTestConfig {
  const addonConfigPath = join(__dirname, '..', 'applications', addonName, 'appconf.json');
  if (!existsSync(addonConfigPath)) {
    throw new Error(`Addon config not found: ${addonConfigPath}`);
  }
  return JSON.parse(readFileSync(addonConfigPath, 'utf-8'));
}

const loader = new E2EApplicationLoader(join(__dirname, '../applications'));

test.describe('Addon Installation E2E Tests', () => {
  let applications: E2EApplication[];

  test.beforeAll(async () => {
    applications = await loader.loadAll();
    console.log(`Loaded ${applications.length} test applications`);
  });

  test('install node-red with samba-shares addon', async ({ page }) => {
    // Load addon configuration
    const addonConfig = loadAddonConfig('samba-addon');
    console.log(`Testing addon: ${addonConfig.addon} on base application: ${addonConfig.baseApplication}`);

    // Find base application (node-red)
    const app = applications.find((a) => a.name === addonConfig.baseApplication);
    expect(app, `Base application ${addonConfig.baseApplication} should exist`).toBeDefined();

    const helper = new ApplicationInstallHelper(page);

    // Step 0: Cleanup existing application
    console.log(`Cleaning up existing application: ${app!.applicationId}`);
    const cleanup = helper.cleanupApplication(app!.applicationId);
    console.log(`Cleanup result: ${cleanup.message}`);

    // Step 1: Create the base application via wizard (Save only, no install yet)
    console.log(`Creating application: ${app!.name}`);
    await helper.createApplication(app!, { installAfterSave: false });
    console.log(`Application created: ${app!.name}`);

    // Step 2: Navigate to Applications page
    await page.goto('/applications');
    await page.waitForLoadState('networkidle');
    console.log('Navigated to Applications page');

    // Step 3: Find the created application card and click Install
    // The application name shown is from the docker-compose service name or application ID
    const appCard = page.locator('.card').filter({
      has: page.locator(`h2:text-is("${app!.name}"), h2:text-is("${app!.applicationId}")`)
    }).first();

    // If not found by exact name, try partial match
    let foundCard = await appCard.count() > 0;
    if (!foundCard) {
      console.log('Card not found by exact match, trying partial match...');
      const cards = page.locator('.card');
      const count = await cards.count();
      for (let i = 0; i < count; i++) {
        const cardText = await cards.nth(i).textContent();
        if (cardText?.toLowerCase().includes(app!.name.toLowerCase())) {
          foundCard = true;
          await cards.nth(i).locator('button:has-text("Install")').click();
          break;
        }
      }
    } else {
      await expect(appCard).toBeVisible({ timeout: 10000 });
      const installBtn = appCard.locator('[data-testid="install-app-btn"]').or(
        appCard.locator('button:has-text("Install")')
      );
      await installBtn.click();
    }

    expect(foundCard, 'Application card should be found').toBe(true);
    console.log('Clicked Install button');

    // Step 4: Wait for ve-configuration-dialog to open
    await page.waitForSelector('mat-dialog-container', { timeout: 10000 });
    await page.waitForLoadState('networkidle');
    console.log('Configuration dialog opened');

    // Step 5: Wait for addon section to appear and select samba addon
    const addonSection = page.locator('app-addon-section');
    await expect(addonSection).toBeVisible({ timeout: 15000 });
    console.log('Addon section visible');

    // Find and click the samba checkbox
    const sambaCheckbox = page.locator('mat-checkbox').filter({
      hasText: /Samba/i
    }).first();
    await expect(sambaCheckbox).toBeVisible({ timeout: 10000 });
    await sambaCheckbox.click();
    console.log('Samba addon selected');

    // Step 6: Click Configure button to expand addon parameters
    // The button is next to the checkbox, look for it within the addon row
    const configureBtn = page.locator('button').filter({ hasText: /Configure/i }).first();
    await expect(configureBtn).toBeVisible({ timeout: 5000 });
    await configureBtn.click();
    console.log('Clicked Configure button');

    // Wait for the addon parameters panel to expand
    await page.waitForTimeout(1000);

    // Step 7: Fill addon parameters
    // Fill smb_user - look for input with the label
    const smbUserInput = page.locator('input').filter({
      has: page.locator('xpath=ancestor::mat-form-field//mat-label[contains(text(), "Samba Username")]')
    }).first();

    // Alternative: find by looking at visible inputs after Configure was clicked
    let foundUserInput = false;
    const allInputs = page.locator('mat-form-field input');
    const inputCount = await allInputs.count();
    console.log(`Found ${inputCount} input fields`);

    for (let i = 0; i < inputCount; i++) {
      const input = allInputs.nth(i);
      const formField = input.locator('xpath=ancestor::mat-form-field');
      const label = await formField.locator('mat-label').textContent().catch(() => '');
      console.log(`Input ${i}: label="${label}"`);

      if (label?.toLowerCase().includes('samba username')) {
        await input.fill(addonConfig.addonParams.smb_user);
        console.log(`Filled smb_user: ${addonConfig.addonParams.smb_user}`);
        foundUserInput = true;
        break;
      }
    }

    expect(foundUserInput, 'Samba Username input should be found').toBe(true);
    await smbUserInput.fill(addonConfig.addonParams.smb_user);
    console.log(`Filled smb_user: ${addonConfig.addonParams.smb_user}`);

    // Fill smb_password - find by label
    let foundPasswordInput = false;
    for (let i = 0; i < inputCount; i++) {
      const input = allInputs.nth(i);
      const formField = input.locator('xpath=ancestor::mat-form-field');
      const label = await formField.locator('mat-label').textContent().catch(() => '');

      if (label?.toLowerCase().includes('samba password')) {
        await input.fill(addonConfig.addonParams.smb_password);
        console.log('Filled smb_password: ***');
        foundPasswordInput = true;
        break;
      }
    }

    expect(foundPasswordInput, 'Samba Password input should be found').toBe(true);

    // Step 8: Upload smb.conf file if available
    const fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count() > 0) {
      const smbConfPath = join(__dirname, '..', 'applications', 'samba-addon', 'smb.conf');
      if (existsSync(smbConfPath)) {
        await fileInput.setInputFiles(smbConfPath);
        console.log('Uploaded smb.conf');
      }
    }

    // Step 9: Auto-fill required dropdowns (storage, network, etc.)
    await helper.autoFillRequiredDropdowns();
    console.log('Auto-filled required dropdowns');

    // Step 10: Click Install button
    const installButton = page.locator('mat-dialog-container button:has-text("Install")');
    await expect(installButton).toBeEnabled({ timeout: 10000 });
    await installButton.click();
    console.log('Installation started');

    // Step 11: Wait for installation to complete
    const installed = await helper.waitForInstallationComplete(app!.name);
    expect(installed, 'Installation should complete successfully').toBe(true);
    console.log('Installation complete');

    // Step 12: Extract created container VMID
    const createdVmId = await helper.extractCreatedVmId(app!.name);
    expect(createdVmId, 'Container VMID must be extracted').toBeTruthy();
    console.log(`Created container VMID: ${createdVmId}`);

    // Step 13: Validate addon via SSH
    if (addonConfig.validation && createdVmId) {
      const appValidator = new SSHValidator({
        sshHost: getPveHost(),
        sshPort: SSH_PORT,
        containerVmId: createdVmId,
      });

      // Wait before validation
      if (addonConfig.validation.waitBeforeValidation) {
        console.log(`Waiting ${addonConfig.validation.waitBeforeValidation}s before validation...`);
        await page.waitForTimeout(addonConfig.validation.waitBeforeValidation * 1000);
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`Addon Validation for: ${addonConfig.name} (container ${createdVmId})`);
      console.log(`${'='.repeat(60)}`);

      const results: Array<{ success: boolean; message: string; details?: string }> = [];

      // Validate processes
      if (addonConfig.validation.processes) {
        for (const proc of addonConfig.validation.processes) {
          try {
            appValidator.execInContainer(`pgrep -x ${proc.name} || pgrep ${proc.name}`);
            results.push({
              success: true,
              message: `Process ${proc.name} is running`,
            });
          } catch {
            results.push({
              success: false,
              message: `Process ${proc.name} is NOT running`,
              details: proc.description,
            });
          }
        }
      }

      // Validate ports
      if (addonConfig.validation.ports) {
        for (const port of addonConfig.validation.ports) {
          try {
            const output = appValidator.execInContainer(`ss -tlnp | grep :${port.port}`);
            results.push({
              success: output.includes(`:${port.port}`),
              message: `Port ${port.port} (${port.service || 'unknown'}) is listening`,
            });
          } catch {
            results.push({
              success: false,
              message: `Port ${port.port} (${port.service || 'unknown'}) is NOT listening`,
            });
          }
        }
      }

      // Validate files
      if (addonConfig.validation.files) {
        for (const file of addonConfig.validation.files) {
          try {
            const output = appValidator.execInContainer(`cat "${file.path}"`);
            const patternMatch = file.contentPattern
              ? new RegExp(file.contentPattern).test(output)
              : true;
            results.push({
              success: patternMatch,
              message: `File ${file.path} exists${file.contentPattern ? ' and matches pattern' : ''}`,
            });
          } catch {
            results.push({
              success: false,
              message: `File ${file.path} does NOT exist`,
            });
          }
        }
      }

      // Validate commands
      if (addonConfig.validation.commands) {
        for (const cmd of addonConfig.validation.commands) {
          try {
            const output = appValidator.execInContainer(cmd.command);
            const outputMatch = cmd.expectedOutput
              ? output.includes(cmd.expectedOutput)
              : true;
            results.push({
              success: outputMatch,
              message: cmd.description || `Command "${cmd.command}" succeeded`,
              details: output.substring(0, 200),
            });
          } catch (error) {
            results.push({
              success: false,
              message: cmd.description || `Command "${cmd.command}" failed`,
              details: String(error),
            });
          }
        }
      }

      // Log results
      const passed = results.filter(r => r.success);
      const failed = results.filter(r => !r.success);

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
            console.log(`    Details: ${result.details}`);
          }
        }
      }

      console.log(`\n${'─'.repeat(60)}`);
      console.log(`Summary: ${passed.length}/${results.length} addon validations passed`);
      console.log(`${'─'.repeat(60)}\n`);

      expect(failed.length, `${failed.length} addon validations failed`).toBe(0);
    }
  });
});
