import { test as base, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { join } from 'path';

/**
 * E2E Test Fixtures
 *
 * Provides common utilities for all E2E tests:
 * - Environment configuration
 * - Snapshot reset before tests
 * - API helpers
 */

export const API_URL = process.env.E2E_API_URL || 'http://10.99.0.10:3000';
export const SSH_HOST = process.env.E2E_SSH_HOST || '10.99.0.10';

// Path to e2e scripts
const SCRIPTS_DIR = join(__dirname, '../scripts');

/**
 * Reset to baseline snapshot
 * Call this before tests that need a clean state
 */
export async function resetToBaseline(vmId: string = '300', snapshotName: string = 'e2e-baseline') {
  const script = join(SCRIPTS_DIR, 'snapshot-rollback.sh');
  try {
    execSync(`SSH_HOST=${SSH_HOST} ${script} ${vmId} ${snapshotName}`, {
      timeout: 120000, // 2 minutes for rollback
      stdio: 'pipe',
    });
    // Wait for services to start after rollback
    await new Promise((resolve) => setTimeout(resolve, 10000));
  } catch (error) {
    console.warn(`Snapshot rollback failed (may not exist yet): ${error}`);
  }
}

/**
 * Extended test with E2E fixtures
 */
export const test = base.extend<{
  apiUrl: string;
  sshHost: string;
}>({
  apiUrl: async ({}, use) => {
    await use(API_URL);
  },

  sshHost: async ({}, use) => {
    await use(SSH_HOST);
  },
});

export { expect };

/**
 * Helper to wait for API health
 */
export async function waitForApiHealth(apiUrl: string = API_URL, maxWait: number = 60000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWait) {
    try {
      const response = await fetch(`${apiUrl}/api/health`);
      if (response.ok) {
        return true;
      }
    } catch {
      // API not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`API at ${apiUrl} did not become healthy within ${maxWait}ms`);
}
