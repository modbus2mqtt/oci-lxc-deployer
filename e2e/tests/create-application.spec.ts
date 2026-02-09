import { test, expect, API_URL, waitForApiHealth } from '../fixtures/test-base';
import { E2EApplicationLoader, E2EApplication } from '../utils/application-loader';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Create Application E2E Tests
 *
 * These tests dynamically generate test cases for each application
 * defined in e2e/applications/ directory.
 *
 * Each application directory can contain:
 * - appconf.json: Optional configuration override
 * - *.yml/*.yaml: Docker compose file
 * - icon.svg/icon.png: Application icon
 * - *.env: Environment file
 * - Additional files referenced in uploadfiles
 */

const loader = new E2EApplicationLoader(join(__dirname, '../applications'));

test.describe('Create Application E2E Tests', () => {
  let applications: E2EApplication[];

  test.beforeAll(async () => {
    // Wait for API to be ready
    await waitForApiHealth(API_URL);

    // Load all test applications
    applications = await loader.loadAll();
    console.log(`Loaded ${applications.length} test applications`);
  });

  test('should load test applications', async () => {
    expect(applications.length).toBeGreaterThan(0);

    // Log loaded applications for debugging
    for (const app of applications) {
      console.log(`  - ${app.name}:`);
      console.log(`      Directory: ${app.directory}`);
      if (app.dockerCompose) console.log(`      Docker Compose: ${app.dockerCompose}`);
      if (app.icon) console.log(`      Icon: ${app.icon}`);
      if (app.tasktype) console.log(`      Task Type: ${app.tasktype}`);
    }
  });

  test('each application has required files', async () => {
    for (const app of applications) {
      // Each application should have a docker-compose file
      expect(app.dockerCompose, `${app.name} should have a docker-compose file`).toBeDefined();

      // Each application should have an icon
      expect(app.icon, `${app.name} should have an icon`).toBeDefined();
    }
  });

  // TODO: Add UI-based tests once data-testid attributes are added to the frontend
  // These tests will:
  // 1. Navigate to create page
  // 2. Fill application name
  // 3. Upload docker-compose file
  // 4. Upload icon
  // 5. Handle tasktype-specific setup (e.g., postgres)
  // 6. Upload additional files from uploadfiles
  // 7. Submit and verify creation
  //
  // Example (uncomment and adjust selectors when ready):
  //
  // for (const app of applications) {
  //   test(`create ${app.name} application`, async ({ page }) => {
  //     await page.goto('/create');
  //
  //     // Fill application name
  //     await page.fill('[data-testid="app-name"]', app.name);
  //
  //     // Upload docker-compose if exists
  //     if (app.dockerCompose) {
  //       await page.setInputFiles('[data-testid="docker-compose-upload"]', app.dockerCompose);
  //     }
  //
  //     // Upload icon if exists
  //     if (app.icon) {
  //       await page.setInputFiles('[data-testid="icon-upload"]', app.icon);
  //     }
  //
  //     // Handle tasktype specific setup
  //     if (app.tasktype === 'postgres') {
  //       await page.click('[data-testid="enable-postgres"]');
  //     }
  //
  //     // Upload additional files
  //     for (const file of app.uploadfiles || []) {
  //       await page.setInputFiles('[data-testid="file-upload"]',
  //         `${app.directory}/${file.filename}`);
  //     }
  //
  //     // Submit and verify
  //     await page.click('[data-testid="create-submit"]');
  //     await expect(page.locator('[data-testid="success-message"]')).toBeVisible();
  //   });
  // }
});
