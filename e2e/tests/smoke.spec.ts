import { test, expect, selectPveHost, getPveHost } from '../fixtures/test-base';

test.describe('Smoke Tests', () => {
  test('frontend loads successfully', async ({ page }) => {
    await page.goto('/');
    // Check that the app title or main content is visible
    await expect(page.locator('body')).toBeVisible();
    // Wait for Angular to bootstrap
    await page.waitForLoadState('networkidle');
  });

  test('API health endpoint responds', async ({ request }) => {
    // Uses Playwright's baseURL (localhost:4200 for local, nested-vm URL otherwise)
    const response = await request.get('/api/health');
    expect(response.ok()).toBeTruthy();
  });

  test('can select Proxmox host', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Select the PVE host from dropdown (uses config default)
    await selectPveHost(page);

    // Verify selection is reflected in the dropdown
    const hostSelector = page.locator('[data-testid="host-selector"]');
    await expect(hostSelector).toContainText(getPveHost());
  });

  test('applications list loads', async ({ page }) => {
    await page.goto('/');
    // Wait for applications to load
    await page.waitForLoadState('networkidle');
    // Check that some content is displayed
    await expect(page.locator('body')).not.toBeEmpty();
  });
});
