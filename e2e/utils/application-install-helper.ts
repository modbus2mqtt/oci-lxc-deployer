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
    // Debug: Log all network requests and console messages
    this.page.on('console', msg => console.log('BROWSER:', msg.type(), msg.text()));
    this.page.on('requestfailed', request => {
      console.log('REQUEST FAILED:', request.url(), request.failure()?.errorText);
    });

    const response = await this.page.goto('/create-application');
    console.log('Navigated to:', this.page.url());
    console.log('Response status:', response?.status());

    // Wait for Angular to fully load
    await this.page.waitForLoadState('domcontentloaded');

    // Step 1: Wait for framework select to be visible
    const frameworkSelect = this.page.locator('[data-testid="framework-select"]');
    await frameworkSelect.waitFor({ state: 'visible', timeout: 15000 });
    console.log('Framework select visible');

    // Step 2: Wait for frameworks to be loaded by checking if select has a value
    // The default framework (oci-image) should be auto-selected
    await this.page.waitForFunction(() => {
      const select = document.querySelector('[data-testid="framework-select"]');
      // Check if mat-select has a selected value (not empty placeholder)
      const valueText = select?.querySelector('.mat-mdc-select-value-text');
      return valueText && valueText.textContent && valueText.textContent.includes('oci-image');
    }, { timeout: 15000 });
    console.log('Framework oci-image is selected');

    // Step 3: Wait for compose file input (rendered after framework selection)
    await this.page.locator('#compose-file-input').waitFor({ state: 'attached', timeout: 15000 });
    console.log('Compose file input is attached');
  }

  /**
   * Select a framework in step 1
   */
  async selectFramework(frameworkId: string): Promise<void> {
    const frameworkSelect = this.page.locator('[data-testid="framework-select"]').or(
      this.page.locator('mat-select').first()
    );
    await frameworkSelect.click();

    // Wait for dropdown options to appear
    const option = this.page.locator(`mat-option:has-text("${frameworkId}")`);
    await option.waitFor({ state: 'visible' });
    await option.click();

    // Wait for dropdown to close
    await this.page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  /**
   * Upload docker-compose file
   */
  async uploadDockerCompose(filePath: string): Promise<void> {
    const fileInput = this.page.locator('[data-testid="docker-compose-upload"]').or(
      this.page.locator('#compose-file-input')
    );
    await fileInput.setInputFiles(filePath);

    // Wait for file to be parsed - indicated by services hint appearing or error
    await this.page.locator('mat-hint:has-text("Services:"), mat-error').first().waitFor({
      state: 'visible',
      timeout: 10000
    }).catch(() => {});
  }

  /**
   * Upload .env file (optional)
   */
  async uploadEnvFile(filePath: string): Promise<void> {
    const fileInput = this.page.locator('[data-testid="env-file-upload"]').or(
      this.page.locator('#env-file-input')
    );
    await fileInput.setInputFiles(filePath);

    // Wait for network to settle after file upload
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Upload icon file
   */
  async uploadIcon(filePath: string): Promise<void> {
    const fileInput = this.page.locator('[data-testid="icon-upload"]').or(
      this.page.locator('app-icon-upload input[type="file"]')
    );
    await fileInput.setInputFiles(filePath);

    // Wait for icon preview to appear (indicates successful upload)
    await this.page.locator('app-icon-upload img, app-icon-upload .icon-preview').first().waitFor({
      state: 'visible',
      timeout: 5000
    }).catch(() => {});
  }

  /**
   * Fill application properties form
   */
  async fillAppProperties(name: string, description?: string): Promise<void> {
    const nameInput = this.page.locator('[data-testid="app-name-input"]').or(
      this.page.locator('input[formControlName="name"]')
    );
    await nameInput.waitFor({ state: 'visible' });
    await nameInput.fill(name);

    // Fill applicationId (derived from name: lowercase, replace spaces with hyphens)
    const appIdInput = this.page.locator('input[formControlName="applicationId"]');
    await appIdInput.waitFor({ state: 'visible' });

    // Check if applicationId was auto-filled (e.g., from OCI annotations)
    const currentValue = await appIdInput.inputValue();
    if (!currentValue || currentValue.trim() === '') {
      // Generate applicationId from name
      const appId = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      await appIdInput.fill(appId);
    }

    if (description) {
      const descInput = this.page.locator('[data-testid="app-description-input"]').or(
        this.page.locator('textarea[formControlName="description"]')
      );
      await descInput.fill(description);
    }
  }

  /**
   * Select tags in the tags selector
   * @param tags - Array of tag names to select (e.g., ['Database', 'Monitoring'])
   */
  async selectTags(tags: string[]): Promise<void> {
    if (!tags || tags.length === 0) return;

    // Wait for tags selector to be visible
    const tagsSection = this.page.locator('app-tags-selector');
    await tagsSection.waitFor({ state: 'visible', timeout: 10000 });

    for (const tag of tags) {
      // Find mat-chip-option with the tag name and click it
      const chipOption = this.page.locator(`mat-chip-option:has-text("${tag}")`);
      if (await chipOption.count() > 0) {
        await chipOption.click();
        // Wait a bit for selection animation
        await this.page.waitForTimeout(100);
      } else {
        console.warn(`Tag "${tag}" not found in tags selector`);
      }
    }
  }

  /**
   * Click Next button to proceed to next step
   */
  async clickNext(): Promise<void> {
    // Find the visible Next button (mat-stepper hides inactive step content)
    const nextBtn = this.page.locator('[data-testid="next-step-btn"]:visible');
    await nextBtn.waitFor({ state: 'visible', timeout: 10000 });
    await nextBtn.click();

    // Wait for step transition animation to complete
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Click Create Application button in summary step
   */
  async clickCreate(): Promise<void> {
    // Find the visible Create Application button
    const createBtn = this.page.locator('[data-testid="create-application-btn"]:visible');
    await createBtn.waitFor({ state: 'visible', timeout: 10000 });
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
    // goToCreateApplication already waits for #compose-file-input (framework auto-selected)
    await this.goToCreateApplication();

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

    // Select tags if provided
    if (app.tags && app.tags.length > 0) {
      await this.selectTags(app.tags);
    }

    // Upload icon if exists
    if (app.icon) {
      await this.uploadIcon(app.icon);
    }

    // Click Next to go to Step 3 (Parameters)
    await this.clickNext();

    // Step 3: Parameters - usually auto-filled, just proceed
    await this.page.waitForLoadState('networkidle');
    await this.clickNext();

    // Step 4: Summary - Create the application
    await this.clickCreate();

    // Wait for API call to complete
    await this.page.waitForLoadState('networkidle');

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
    // Cards use .card class with h2 containing the app name
    return this.page.locator(`.card:has(h2:text-is("${appName}"))`).first();
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

    // Wait for dialog content to fully load (async data like storage options)
    await this.page.waitForLoadState('networkidle');

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

    // Auto-fill required dropdowns that are empty (like volume_storage)
    await this.autoFillRequiredDropdowns();

    // Click Install button in dialog
    const confirmBtn = this.page.locator('[data-testid="confirm-install-btn"]').or(
      this.page.locator('mat-dialog-container button:has-text("Install")')
    );

    // Wait for Install button to be enabled (required fields filled)
    await expect(confirmBtn).toBeEnabled({ timeout: 10000 });
    await confirmBtn.click();

    // Should redirect to monitor page
    await expect(this.page).toHaveURL(/\/monitor/, { timeout: 30000 });
  }

  /**
   * Auto-fill required dropdowns that don't have a value selected.
   * This handles cases like volume_storage where async data needs to load first.
   */
  private async autoFillRequiredDropdowns(): Promise<void> {
    const dialog = this.page.locator('mat-dialog-container');

    // Check for app-enum-select components which are commonly used for storage selection
    const enumSelects = dialog.locator('app-enum-select');
    const enumCount = await enumSelects.count();

    for (let i = 0; i < enumCount; i++) {
      const enumSelect = enumSelects.nth(i);

      // Check if this is a required field by looking for asterisk in label
      const label = await enumSelect.locator('..').locator('[class*="label"], label').first().textContent().catch(() => '');
      const isRequired = label?.includes('*') ?? false;

      if (isRequired) {
        // Find the combobox/select within this component
        const combobox = enumSelect.locator('[role="combobox"], mat-select');
        if (await combobox.count() > 0) {
          // Check if it has a value selected
          const hasValue = await combobox.locator('.mat-mdc-select-value-text, .mat-select-value-text').count() > 0;

          if (!hasValue) {
            // Wait for options to be available, then click to open dropdown
            await combobox.click();

            // Wait for options panel to appear
            await this.page.locator('.mat-mdc-select-panel, .mat-select-panel, [role="listbox"]').waitFor({
              state: 'visible',
              timeout: 5000
            });

            // Select first available option
            const firstOption = this.page.locator('mat-option').first();
            await firstOption.waitFor({ state: 'visible', timeout: 5000 });
            await firstOption.click();

            // Wait for dropdown to close
            await this.page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
          }
        }
      }
    }

    // Also handle direct mat-select elements marked as required
    const matSelects = dialog.locator('mat-select[required], mat-select[ng-reflect-required="true"]');
    const selectCount = await matSelects.count();

    for (let i = 0; i < selectCount; i++) {
      const select = matSelects.nth(i);
      const hasValue = await select.locator('.mat-mdc-select-value-text, .mat-select-value-text').count() > 0;

      if (!hasValue) {
        await select.click();
        await this.page.locator('.mat-mdc-select-panel, .mat-select-panel').waitFor({ state: 'visible', timeout: 5000 });
        const firstOption = this.page.locator('mat-option').first();
        await firstOption.waitFor({ state: 'visible', timeout: 5000 });
        await firstOption.click();
        await this.page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      }
    }
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

      // Poll every 2 seconds (using networkidle to be more efficient)
      await this.page.waitForLoadState('networkidle');
      await this.page.waitForTimeout(2000); // Brief pause between polls
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
