import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E Test Configuration
 *
 * Environment variables:
 *   E2E_BASE_URL - Frontend URL (default: http://localhost:3000)
 *   E2E_API_URL  - Backend API URL (default: http://localhost:3000)
 *   E2E_SSH_HOST - SSH host for snapshot commands (default: 10.99.0.10)
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // Sequential for Proxmox state-dependent tests
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // Single worker for stateful tests
  timeout: 180000, // 3min per test (container creation is slow)

  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    headless: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Output directory for test artifacts
  outputDir: './e2e/test-results',

  // Local development server
  webServer: {
    command: 'npm run build && oci-lxc-deployer --local ./backend/local',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
