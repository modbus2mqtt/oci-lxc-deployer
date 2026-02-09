import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Test Configuration
 *
 * Projects:
 *   local     - Angular dev server on localhost:4200, API proxied to ubuntupve:3000
 *   nested-vm - Direct connection to ubuntupve:3000 (no local server needed)
 *
 * Usage:
 *   npx playwright test --project=local      # Run with local Angular dev server
 *   npx playwright test --project=nested-vm  # Run directly against nested VM
 *
 * Environment variables:
 *   E2E_VM_URL   - Nested VM URL (default: http://ubuntupve:3000)
 *   E2E_SSH_HOST - SSH host for snapshot commands (default: 10.99.0.10)
 */

const vmUrl = process.env.E2E_VM_URL || 'http://ubuntupve:3000';

// Check if we're running with nested-vm project only
const isNestedVmOnly = process.argv.includes('--project=nested-vm');

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Sequential for Proxmox state-dependent tests
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Single worker for stateful tests
  timeout: 180000, // 3min per test (container creation is slow)

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
