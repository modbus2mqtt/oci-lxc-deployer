import { test, expect } from '@playwright/test';

// test('serves index.html at /', async ({ page }) => {
//   await page.goto('/');
//   await expect(page.locator('body')).toBeVisible();
//   // Optional: check title or visible UI structure
//   // await expect(page).toHaveTitle(/LXC|Manager/i);
// });

test('applications API responds with 200', async ({ request }) => {
  const res = await request.get('/api/applications');
  expect(res.status()).toBe(200);
  const data = await res.json();
  expect(Array.isArray(data)).toBe(true);
});
