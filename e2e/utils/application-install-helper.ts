import { Page, expect, Locator } from '@playwright/test';
import { E2EApplication } from './application-loader';

/**
 * Page Object for application creation and installation via UI.
 *
 * Encapsulates the navigation logic for:
 * - Creating new applications via the create-application wizard
 * - Installing existing applications from the applications list
 * - Waiting for installation to complete
 *
 * @example
 * ```typescript
 * const helper = new ApplicationInstallHelper(page);
 * await helper.createApplication(app);
 * await helper.installApplication(app.name);
 * await helper.waitForInstallationComplete();
 * ```
 */
export class ApplicationInstallHelper {
  constructor(private page: Page) {}

  /**
   * Navigate to applications list
   */
  async goToApplications(): Promise<void> {
    await this.page.goto('/applications');
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Navigate to create application page
   */
  async goToCreateApplication(): Promise<void> {
    await this.page.goto('/create-application');
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Select a framework in step 1
   */
  async selectFramework(frameworkId: string): Promise<void> {
    const frameworkSelect = this.page.locator('[data-testid="framework-select"]').or(
      this.page.locator('mat-select').first()
    );
    await frameworkSelect.click();
    await this.page.locator(`mat-option:has-text("${frameworkId}")`).click();
    await this.page.waitForTimeout(500);
  }

  /**
   * Upload docker-compose file
   */
  async uploadDockerCompose(filePath: string): Promise<void> {
    const fileInput = this.page.locator('[data-testid="docker-compose-upload"]').or(
      this.page.locator('#compose-file-input')
    );
    await fileInput.setInputFiles(filePath);
    // Wait for file parsing
    await this.page.waitForTimeout(1000);
  }

  /**
   * Upload .env file (optional)
   */
  async uploadEnvFile(filePath: string): Promise<void> {
    const fileInput = this.page.locator('[data-testid="env-file-upload"]').or(
      this.page.locator('#env-file-input')
    );
    await fileInput.setInputFiles(filePath);
    await this.page.waitForTimeout(500);
  }

  /**
   * Upload icon file
   */
  async uploadIcon(filePath: string): Promise<void> {
    const fileInput = this.page.locator('[data-testid="icon-upload"]').or(
      this.page.locator('app-icon-upload input[type="file"]')
    );
    await fileInput.setInputFiles(filePath);
    await this.page.waitForTimeout(500);
  }

  /**
   * Fill application properties form
   */
  async fillAppProperties(name: string, description?: string): Promise<void> {
    const nameInput = this.page.locator('[data-testid="app-name-input"]').or(
      this.page.locator('input[formControlName="name"]')
    );
    await nameInput.fill(name);

    // ApplicationId is auto-generated from name, but wait for it
    await this.page.waitForTimeout(500);

    if (description) {
      const descInput = this.page.locator('[data-testid="app-description-input"]').or(
        this.page.locator('textarea[formControlName="description"]')
      );
      await descInput.fill(description);
    }
  }

  /**
   * Click Next button to proceed to next step
   */
  async clickNext(): Promise<void> {
    const nextBtn = this.page.locator('[data-testid="next-step-btn"]').or(
      this.page.locator('button[matStepperNext]')
    );
    await nextBtn.click();
    await this.page.waitForTimeout(500);
  }

  /**
   * Click Create Application button in summary step
   */
  async clickCreate(): Promise<void> {
    const createBtn = this.page.locator('[data-testid="create-application-btn"]').or(
      this.page.locator('button:has-text("Create Application")')
    );
    await createBtn.click();
  }

  /**
   * Create a new application via the create-application wizard.
   *
   * Steps:
   * 1. Navigate to /create-application
   * 2. Select docker-compose framework
   * 3. Upload docker-compose file
   * 4. Fill app properties (name, description)
   * 5. Upload icon (optional)
   * 6. Navigate through parameters step
   * 7. Create application
   */
  async createApplication(app: E2EApplication): Promise<void> {
    await this.goToCreateApplication();

    // Step 1: Select Framework (default is oci-image, we need docker-compose)
    // The framework selector should show docker-compose or oci-image with compose mode
    await this.page.waitForSelector('mat-select');

    // Check if we need to select a specific framework or if oci-image with compose mode works
    const frameworkSelect = this.page.locator('mat-select').first();
    await frameworkSelect.click();

    // Look for docker-compose option or oci-image
    const dockerComposeOption = this.page.locator('mat-option:has-text("docker-compose")');
    const ociImageOption = this.page.locator('mat-option:has-text("oci-image")');

    if (await dockerComposeOption.isVisible()) {
      await dockerComposeOption.click();
    } else if (await ociImageOption.isVisible()) {
      await ociImageOption.click();
      // Select compose mode if oci-image
      await this.page.waitForTimeout(500);
      const composeToggle = this.page.locator('mat-button-toggle:has-text("docker-compose")');
      if (await composeToggle.isVisible()) {
        await composeToggle.click();
      }
    }

    await this.page.waitForTimeout(500);

    // Upload docker-compose file
    if (app.dockerCompose) {
      await this.uploadDockerCompose(app.dockerCompose);
    }

    // Upload env file if exists
    if (app.envFile) {
      await this.uploadEnvFile(app.envFile);
    }

    // Click Next to go to Step 2 (Application Properties)
    await this.clickNext();

    // Step 2: Fill Application Properties
    await this.fillAppProperties(app.name, app.description);

    // Upload icon if exists
    if (app.icon) {
      await this.uploadIcon(app.icon);
    }

    // Click Next to go to Step 3 (Parameters)
    await this.clickNext();

    // Step 3: Parameters - usually auto-filled, just proceed
    await this.page.waitForTimeout(500);
    await this.clickNext();

    // Step 4: Summary - Create the application
    await this.clickCreate();

    // Wait for success message or navigation
    await this.page.waitForTimeout(2000);

    // Check for success - either a success message or navigation to applications list
    const successIndicator = this.page.locator('[data-testid="installation-success"]').or(
      this.page.locator('text=successfully')
    );

    // Allow some time for the creation process
    try {
      await successIndicator.waitFor({ timeout: 30000 });
    } catch {
      // If no success indicator, check if we're back on applications page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/applications')) {
        throw new Error('Application creation failed - no success indicator found');
      }
    }
  }

  /**
   * Find an application card by name in the applications list
   */
  private getAppCard(appName: string): Locator {
    return this.page.locator(`[data-testid="app-card-${appName}"]`).or(
      this.page.locator(`.app-card:has-text("${appName}")`).or(
        this.page.locator(`mat-card:has-text("${appName}")`)
      )
    );
  }

  /**
   * Install an existing application from the applications list.
   *
   * @param appName - Name of the application to install
   * @param params - Optional parameters to fill in the install dialog
   */
  async installApplication(appName: string, params?: Record<string, string>): Promise<void> {
    await this.goToApplications();

    // Find the application card
    const appCard = this.getAppCard(appName);
    await expect(appCard).toBeVisible({ timeout: 10000 });

    // Click Install button
    const installBtn = appCard.locator('[data-testid="install-app-btn"]').or(
      appCard.locator('button:has-text("Install")')
    );
    await installBtn.click();

    // Wait for install dialog to open
    await this.page.waitForSelector('mat-dialog-container', { timeout: 10000 });

    // Fill in parameters if provided
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        const input = this.page.locator(
          `mat-dialog-container input[formControlName="${key}"], ` +
          `mat-dialog-container mat-select[formControlName="${key}"]`
        );

        if (await input.count() > 0) {
          const tagName = await input.evaluate((el) => el.tagName.toLowerCase());
          if (tagName === 'mat-select') {
            await input.click();
            await this.page.locator(`mat-option:has-text("${value}")`).click();
          } else {
            await input.fill(value);
          }
        }
      }
    }

    // Click Install button in dialog
    const confirmBtn = this.page.locator('[data-testid="confirm-install-btn"]').or(
      this.page.locator('mat-dialog-container button:has-text("Install")')
    );
    await confirmBtn.click();

    // Should redirect to monitor page
    await expect(this.page).toHaveURL(/\/monitor/, { timeout: 30000 });
  }

  /**
   * Wait for installation to complete on the monitor page.
   *
   * @param timeout - Maximum time to wait in milliseconds (default: 3 minutes)
   * @returns true if installation succeeded
   * @throws Error if installation failed or timed out
   */
  async waitForInstallationComplete(timeout: number = 180000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      // Check for success indicator
      const successBlock = this.page.locator('[data-testid="installation-success"]').or(
        this.page.locator('.success-block, .installation-complete, text=Installation complete')
      );

      if (await successBlock.isVisible()) {
        return true;
      }

      // Check for error indicator
      const errorBlock = this.page.locator('[data-testid="installation-error"]').or(
        this.page.locator('.error-block, .installation-error')
      );

      if (await errorBlock.isVisible()) {
        const errorText = await errorBlock.textContent();
        throw new Error(`Installation failed: ${errorText}`);
      }

      // Wait before checking again
      await this.page.waitForTimeout(5000);
    }

    throw new Error(`Installation timed out after ${timeout}ms`);
  }

  /**
   * Convenience method: Create and install an application in one go.
   */
  async createAndInstall(app: E2EApplication, installParams?: Record<string, string>): Promise<void> {
    await this.createApplication(app);
    await this.installApplication(app.name, installParams);
    await this.waitForInstallationComplete();
  }
}
