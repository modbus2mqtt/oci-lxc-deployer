import { test, expect, API_URL, waitForApiHealth } from '../fixtures/test-base';

test.describe('Smoke Tests', () => {
  test.beforeAll(async () => {
    // Wait for API to be ready
    await waitForApiHealth(API_URL);
  });

  test('frontend loads successfully', async ({ page }) => {
    await page.goto('/');
    // Check that the app title or main content is visible
    await expect(page.locator('body')).toBeVisible();
    // Wait for Angular to bootstrap
    await page.waitForLoadState('networkidle');
  });

  test('API health endpoint responds', async ({ request }) => {
    const response = await request.get(`${API_URL}/api/health`);
    expect(response.ok()).toBeTruthy();
  });

  test('applications list loads', async ({ page }) => {
    await page.goto('/');
    // Wait for applications to load
    await page.waitForLoadState('networkidle');
    // Check that some content is displayed (adjust selector based on actual UI)
    await expect(page.locator('body')).not.toBeEmpty();
  });
});
