import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Playwright E2E Test Configuration
 *
 * Projects:
 *   local     - Angular dev server on localhost:4200, API proxied to backend
 *   nested-vm - Direct connection to nested VM deployer (no local server needed)
 *
 * Usage:
 *   npx playwright test --project=local      # Run with local Angular dev server
 *   npx playwright test --project=nested-vm  # Run directly against nested VM
 *   E2E_INSTANCE=github-action npx playwright test  # Use specific instance
 *
 * Configuration is loaded from e2e/config.json
 */

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
  }>;
  ports: {
    pveWeb: number;
    pveSsh: number;
    deployer: number;
  };
}

const configPath = join(__dirname, 'e2e', 'config.json');
const e2eConfig: E2EConfig = JSON.parse(readFileSync(configPath, 'utf-8'));

// Determine which instance to use
const instanceName = process.env.E2E_INSTANCE || e2eConfig.default;
const instance = e2eConfig.instances[instanceName];
if (!instance) {
  throw new Error(`E2E instance "${instanceName}" not found in config.json`);
}

// Calculate the nested-vm URL from config
const deployerPort = e2eConfig.ports.deployer + instance.portOffset;
const vmUrl = process.env.E2E_VM_URL || `http://${instance.pveHost}:${deployerPort}`;

// Check if we're running with nested-vm project only
const isNestedVmOnly = process.argv.includes('--project=nested-vm');

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: './e2e',
  fullyParallel: false, // Sequential for Proxmox state-dependent tests
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Single worker for stateful tests
  timeout: 600000, // 10min per test (OCI image download + container creation is slow)

  reporter: process.env.CI ? 'github' : 'list',

  // Shared settings for all projects
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    headless: true,
    ...devices['Desktop Chrome'],
    viewport: { width: 1920, height: 1080 },
  },

  projects: [
    {
      name: 'local',
      use: {
        baseURL: 'http://localhost:4200',
      },
    },
    {
      name: 'nested-vm',
      use: {
        baseURL: vmUrl,
      },
    },
  ],

  // Output directory for test artifacts
  outputDir: './e2e/test-results',

  // Angular dev server - only start for local project
  webServer: isNestedVmOnly ? undefined : {
    command: 'cd frontend && pnpm ng serve --configuration=e2e',
    url: 'http://localhost:4200',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
