import { test, expect, getPveHost } from '../fixtures/test-base';
import { SSHValidator } from '../utils/ssh-validator';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Addon Installation E2E Tests
 *
 * These tests verify the flow of:
 * 1. Installing a base application (oci-lxc-deployer)
 * 2. Adding an addon (samba-shares) with configuration
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
  addonFiles: Record<string, string>;
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
  const configPath = join(__dirname, '..', 'applications', addonName, 'appconf.json');
  if (!existsSync(configPath)) {
    throw new Error(`Addon config not found: ${configPath}`);
  }
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

/**
 * Load file content as base64
 */
function loadFileAsBase64(addonName: string, fileName: string): string {
  const filePath = join(__dirname, '..', 'applications', addonName, fileName);
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = readFileSync(filePath, 'utf-8');
  return Buffer.from(content).toString('base64');
}

test.describe('Addon Installation E2E Tests', () => {
  let validator: SSHValidator;

  test.beforeAll(async () => {
    validator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
      containerVmId: '300', // Default deployer container
    });
  });

  test('install samba-shares addon on oci-lxc-deployer', async ({ page }) => {
    // Load addon test configuration
    const config = loadAddonConfig('samba-addon');
    console.log(`Testing addon: ${config.addon} on base application: ${config.baseApplication}`);

    // Step 1: Navigate to applications and find the base application
    await page.goto('/applications');
    await page.waitForLoadState('networkidle');

    // Find the oci-lxc-deployer application card
    const appCard = page.locator(`.card:has(h2:text-is("OCI LXC Deployer"))`).first();
    await expect(appCard).toBeVisible({ timeout: 10000 });

    // Click install button to open configuration dialog
    const installBtn = appCard.locator('[data-testid="install-app-btn"]').or(
      appCard.locator('button:has-text("Install")')
    );
    await installBtn.click();

    // Wait for dialog to open
    await page.waitForSelector('mat-dialog-container', { timeout: 10000 });
    await page.waitForLoadState('networkidle');

    // Step 2: Wait for addons to load and select samba-shares
    console.log('Waiting for addons to load...');

    // Wait for addon section to appear
    const addonSection = page.locator('app-addon-section, [data-testid="addon-section"]');
    await expect(addonSection).toBeVisible({ timeout: 15000 });

    // Find and click the samba-shares addon checkbox
    const sambaAddon = page.locator(`mat-checkbox:has-text("Samba"), [data-testid="addon-samba-shares"]`).first();
    await expect(sambaAddon).toBeVisible({ timeout: 10000 });
    await sambaAddon.click();

    console.log('Samba addon selected');

    // Step 3: Click "Configure" button to expand addon parameters
    const configureBtn = page.locator('button:has-text("Configure")').first();
    await expect(configureBtn).toBeVisible({ timeout: 5000 });
    await configureBtn.click();

    console.log('Addon configuration expanded');

    // Wait for addon parameters to be visible
    await page.waitForTimeout(500);

    // Fill smb_user - search by mat-label text or placeholder
    // Angular Material uses mat-label inside mat-form-field
    const smbUserField = page.locator('mat-form-field:has(mat-label:text-is("Samba Username*")), mat-form-field:has(mat-label:has-text("Samba Username"))').first();
    const smbUserInput = smbUserField.locator('input').first();
    await expect(smbUserInput).toBeVisible({ timeout: 5000 });
    await smbUserInput.fill(config.addonParams.smb_user);
    console.log(`Filled smb_user: ${config.addonParams.smb_user}`);

    // Fill smb_password - search by mat-label text
    const smbPasswordField = page.locator('mat-form-field:has(mat-label:text-is("Samba Password*")), mat-form-field:has(mat-label:has-text("Samba Password"))').first();
    const smbPasswordInput = smbPasswordField.locator('input').first();
    await expect(smbPasswordInput).toBeVisible({ timeout: 5000 });
    await smbPasswordInput.fill(config.addonParams.smb_password);
    console.log(`Filled smb_password: ***`);

    // Step 4: Upload smb.conf file (may be in Advanced Options)
    // First check if there's a file input visible
    let fileInput = page.locator('input[type="file"]').first();
    if (await fileInput.count() === 0 || !(await fileInput.isVisible())) {
      // Click "Show Advanced Options" to reveal file upload
      const advancedBtn = page.locator('button:has-text("Show Advanced Options"), button:has-text("Advanced")').first();
      if (await advancedBtn.isVisible()) {
        await advancedBtn.click();
        console.log('Expanded Advanced Options');
        await page.waitForTimeout(500);
      }
      fileInput = page.locator('input[type="file"]').first();
    }

    if (await fileInput.count() > 0) {
      const smbConfPath = join(__dirname, '..', 'applications', 'samba-addon', 'smb.conf');
      await fileInput.setInputFiles(smbConfPath);
      console.log('Uploaded smb.conf');
    } else {
      console.log('No file input found - addon_content may be optional or handled differently');
    }

    // Step 5: Click Install button
    const confirmBtn = page.locator('[data-testid="confirm-install-btn"]').or(
      page.locator('mat-dialog-container button:has-text("Install")')
    );

    // Wait for button to be enabled (form validation)
    await expect(confirmBtn).toBeEnabled({ timeout: 10000 });
    await confirmBtn.click();

    console.log('Installation started');

    // Step 6: Wait for installation to complete
    await expect(page).toHaveURL(/\/monitor/, { timeout: 30000 });

    // Wait for success indicator
    const successLocator = page.locator('[data-testid="installation-success"]');
    const errorLocator = page.locator('[data-testid="installation-error"]');

    const result = await Promise.race([
      successLocator.waitFor({ state: 'visible', timeout: 180000 }).then(() => 'success' as const),
      errorLocator.waitFor({ state: 'visible', timeout: 180000 }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const);

    if (result === 'error') {
      const errorText = await errorLocator.textContent().catch(() => 'Unknown error');
      throw new Error(`Installation failed: ${errorText}`);
    }

    if (result === 'timeout') {
      throw new Error('Installation timed out after 3 minutes');
    }

    console.log('Installation completed successfully');

    // Step 7: Extract created container VMID
    const successBlock = page.locator('[data-testid="installation-success"]');
    const successText = await successBlock.textContent();
    const containerMatch = successText?.match(/Created container:\s*(\d+)/i);
    const createdVmId = containerMatch ? containerMatch[1] : null;

    expect(createdVmId, 'Container VMID must be extracted').toBeTruthy();
    console.log(`Created container VMID: ${createdVmId}`);

    // Step 8: Validate via SSH
    if (config.validation && createdVmId) {
      const appValidator = new SSHValidator({
        sshHost: getPveHost(),
        sshPort: SSH_PORT,
        containerVmId: createdVmId,
      });

      // Wait before validation
      if (config.validation.waitBeforeValidation) {
        console.log(`Waiting ${config.validation.waitBeforeValidation}s before validation...`);
        await page.waitForTimeout(config.validation.waitBeforeValidation * 1000);
      }

      console.log(`\n${'='.repeat(60)}`);
      console.log(`Validation for: ${config.name} (container ${createdVmId})`);
      console.log(`${'='.repeat(60)}`);

      const results: Array<{ success: boolean; message: string; details?: string }> = [];

      // Validate processes
      if (config.validation.processes) {
        for (const proc of config.validation.processes) {
          try {
            const output = appValidator.execInContainer(`pgrep -x ${proc.name} || pgrep ${proc.name}`);
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
      if (config.validation.ports) {
        for (const port of config.validation.ports) {
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
      if (config.validation.files) {
        for (const file of config.validation.files) {
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
      if (config.validation.commands) {
        for (const cmd of config.validation.commands) {
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
      console.log(`Summary: ${passed.length}/${results.length} validations passed`);
      console.log(`${'─'.repeat(60)}\n`);

      expect(failed.length, `${failed.length} validations failed`).toBe(0);
    }
  });
});
