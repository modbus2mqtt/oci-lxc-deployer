import { test as base, expect, Page } from '@playwright/test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * E2E Test Fixtures
 *
 * Provides common utilities for all E2E tests:
 * - Configuration loaded from e2e/config.json
 * - Proxmox host selection helper
 *
 * Projects:
 *   local     - Uses localhost:4200 (Angular dev server with proxy to backend)
 *   nested-vm - Uses config-based URL (direct connection to nested VM)
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load E2E configuration
interface E2EConfig {
  default: string;
  instances: Record<string, {
    description: string;
    pveHost: string;
    vmId: number;
    vmName: string;
    portOffset: number;
    subnet: string;
    bridge: string;
    /** If set, use local file operations instead of SSH for cleanup */
    localPath?: string;
  }>;
  defaults: {
    deployerStaticIp: string;
    [key: string]: unknown;
  };
  ports: {
    pveWeb: number;
    pveSsh: number;
    deployer: number;
  };
}

const configPath = join(__dirname, '..', 'config.json');
const e2eConfig: E2EConfig = JSON.parse(readFileSync(configPath, 'utf-8'));

// Determine which instance to use
const instanceName = process.env.E2E_INSTANCE || e2eConfig.default;
const instance = e2eConfig.instances[instanceName];

/**
 * Get the configured PVE host name
 */
export function getPveHost(): string {
  return instance?.pveHost || 'ubuntupve';
}

/**
 * Get the SSH port for the nested VM (base port + instance port offset)
 */
export function getSshPort(): number {
  return e2eConfig.ports.pveSsh + (instance?.portOffset || 0);
}

/**
 * Get the deployer port (base port + instance port offset)
 */
export function getDeployerPort(): number {
  return e2eConfig.ports.deployer + (instance?.portOffset || 0);
}

/**
 * Get the deployer static IP from config defaults
 */
export function getDeployerStaticIp(): string {
  return e2eConfig.defaults.deployerStaticIp;
}

/**
 * Get the local path for file operations (if configured).
 * When set, cleanup operations use local fs instead of SSH.
 */
export function getLocalPath(): string | undefined {
  return instance?.localPath;
}

/**
 * Check if running in local mode (local backend with local file storage)
 */
export function isLocalMode(): boolean {
  return !!instance?.localPath;
}

/**
 * Extended test with E2E fixtures
 */
export const test = base.extend<{
  pveHost: string;
}>({
  pveHost: async ({}, use) => {
    await use(getPveHost());
  },
});

export { expect };

/**
 * Select a Proxmox host in the header dropdown
 * @param page - Playwright page object
 * @param hostPattern - Host name or pattern to match. Defaults to configured PVE host.
 */
export async function selectPveHost(page: Page, hostPattern: string = getPveHost()): Promise<void> {
  // Wait for the host selector to be visible
  const hostSelector = page.locator('[data-testid="host-selector"]');
  await hostSelector.waitFor({ state: 'visible', timeout: 10000 });

  // Click to open the dropdown
  await hostSelector.click();

  // Wait for dropdown options to appear
  await page.waitForSelector('mat-option', { state: 'visible', timeout: 5000 });

  // Find and click the matching option
  const option = page.locator('mat-option').filter({ hasText: hostPattern });
  const optionCount = await option.count();

  if (optionCount === 0) {
    // List available options for debugging
    const allOptions = await page.locator('mat-option').allTextContents();
    throw new Error(`Host "${hostPattern}" not found. Available hosts: ${allOptions.join(', ')}`);
  }

  await option.first().click();

  // Wait for selection to complete (dropdown closes)
  await page.waitForSelector('mat-option', { state: 'hidden', timeout: 5000 });
}
