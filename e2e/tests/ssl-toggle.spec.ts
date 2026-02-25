import { test, expect } from '../fixtures/test-base';

/**
 * SSL Toggle E2E Tests
 *
 * Tests the global SSL enable/disable toggle and its effect on certificate auto-generation.
 * The global-setup.ts enables SSL by default for existing tests; these tests verify
 * the toggle API works correctly.
 */
test.describe('SSL Toggle', () => {
  let veContextKey: string;

  test.beforeAll(async ({ request }) => {
    // Get veContextKey from SSH configs
    const sshRes = await request.get('/api/sshconfigs');
    expect(sshRes.ok()).toBeTruthy();
    const sshData = await sshRes.json();
    veContextKey = sshData.key;
    expect(veContextKey).toBeTruthy();
  });

  test('CA info returns ssl_enabled field', async ({ request }) => {
    const res = await request.get(`/api/ve/certificates/ca/${veContextKey}`);
    expect(res.ok()).toBeTruthy();
    const info = await res.json();
    expect(typeof info.ssl_enabled).toBe('boolean');
  });

  test('can disable SSL via API', async ({ request }) => {
    // Disable SSL
    const disableRes = await request.post(`/api/ve/certificates/ssl/${veContextKey}`, {
      data: { ssl_enabled: false },
    });
    expect(disableRes.ok()).toBeTruthy();
    const disableInfo = await disableRes.json();
    expect(disableInfo.ssl_enabled).toBe(false);

    // Verify GET returns disabled
    const getRes = await request.get(`/api/ve/certificates/ca/${veContextKey}`);
    expect(getRes.ok()).toBeTruthy();
    const info = await getRes.json();
    expect(info.ssl_enabled).toBe(false);
  });

  test('can enable SSL via API', async ({ request }) => {
    // Enable SSL
    const enableRes = await request.post(`/api/ve/certificates/ssl/${veContextKey}`, {
      data: { ssl_enabled: true },
    });
    expect(enableRes.ok()).toBeTruthy();
    const enableInfo = await enableRes.json();
    expect(enableInfo.ssl_enabled).toBe(true);

    // Verify GET returns enabled
    const getRes = await request.get(`/api/ve/certificates/ca/${veContextKey}`);
    expect(getRes.ok()).toBeTruthy();
    const info = await getRes.json();
    expect(info.ssl_enabled).toBe(true);
  });

  test('SSL toggle rejects invalid body', async ({ request }) => {
    // Missing ssl_enabled
    const res = await request.post(`/api/ve/certificates/ssl/${veContextKey}`, {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('SSL configured (CA exists) but disabled', async ({ request }) => {
    // Ensure CA exists
    const caRes = await request.get(`/api/ve/certificates/ca/${veContextKey}`);
    const caInfo = await caRes.json();
    if (!caInfo.exists) {
      // Generate CA if not present
      const genRes = await request.post(`/api/ve/certificates/ca/generate/${veContextKey}`, { data: {} });
      expect(genRes.ok()).toBeTruthy();
    }

    // Disable SSL
    const disableRes = await request.post(`/api/ve/certificates/ssl/${veContextKey}`, {
      data: { ssl_enabled: false },
    });
    expect(disableRes.ok()).toBeTruthy();

    // Verify CA exists but SSL is disabled
    const verifyRes = await request.get(`/api/ve/certificates/ca/${veContextKey}`);
    expect(verifyRes.ok()).toBeTruthy();
    const info = await verifyRes.json();
    expect(info.exists).toBe(true);
    expect(info.ssl_enabled).toBe(false);

    // Re-enable SSL for subsequent tests
    await request.post(`/api/ve/certificates/ssl/${veContextKey}`, {
      data: { ssl_enabled: true },
    });
  });
});
