import { defineConfig, devices } from '@playwright/test';
import { getPveHost, getDeployerPort } from './e2e/fixtures/test-base';

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

// Calculate the nested-vm URL from config
const vmUrl = process.env.E2E_VM_URL || `http://${getPveHost()}:${getDeployerPort()}`;

// Check if we're running with nested-vm project only
const isNestedVmOnly = process.argv.includes('--project=nested-vm');

// Configurable frontend port (set via FRONTEND_PORT env var or workspace settings)
const frontendPort = process.env.FRONTEND_PORT || '4200';

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  testDir: './e2e',
  fullyParallel: false, // Sequential for Proxmox state-dependent tests
  forbidOnly: !!process.env.CI,
  retries: 0,
  maxFailures: 3, // Stop early on systematic failures (e.g. wrong SSH port, infra down)
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
        baseURL: `http://localhost:${frontendPort}`,
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
    command: `cd frontend && pnpm ng serve --port ${frontendPort} --configuration=e2e`,
    url: `http://localhost:${frontendPort}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
