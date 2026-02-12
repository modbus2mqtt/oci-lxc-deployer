import { Page, expect, Locator } from '@playwright/test';
import { E2EApplication } from './application-loader';
import { ApplicationCreateHelper } from './application-create-helper';

/**
 * Page Object for application installation via UI.
 *
 * Encapsulates the navigation logic for:
 * - Installing existing applications from the applications list
 * - Waiting for installation to complete
 *
 * @example
 * ```typescript
 * const helper = new ApplicationInstallHelper(page);
 * await helper.installApplication('mosquitto');
 * await helper.waitForInstallationComplete();
 * ```
 */
export class ApplicationInstallHelper {
  private createHelper: ApplicationCreateHelper;

  constructor(private page: Page) {
    this.createHelper = new ApplicationCreateHelper(page);
  }

  /**
   * Navigate to applications list
   */
  async goToApplications(): Promise<void> {
    await this.page.goto('/applications');
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Find an application card by name in the applications list
   */
  private getAppCard(appName: string): Locator {
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

    const appCard = this.getAppCard(appName);
    await expect(appCard).toBeVisible({ timeout: 10000 });

    const installBtn = appCard.locator('[data-testid="install-app-btn"]').or(
      appCard.locator('button:has-text("Install")')
    );
    await installBtn.click();

    await this.page.waitForSelector('mat-dialog-container', { timeout: 10000 });
    await this.page.waitForLoadState('networkidle');

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

    await this.autoFillRequiredDropdowns();

    const confirmBtn = this.page.locator('[data-testid="confirm-install-btn"]').or(
      this.page.locator('mat-dialog-container button:has-text("Install")')
    );

    await expect(confirmBtn).toBeEnabled({ timeout: 10000 });
    await confirmBtn.click();

    await expect(this.page).toHaveURL(/\/monitor/, { timeout: 30000 });
  }

  /**
   * Auto-fill required dropdowns that don't have a value selected.
   */
  private async autoFillRequiredDropdowns(): Promise<void> {
    const dialog = this.page.locator('mat-dialog-container');

    const enumSelects = dialog.locator('app-enum-select');
    const enumCount = await enumSelects.count();

    for (let i = 0; i < enumCount; i++) {
      const enumSelect = enumSelects.nth(i);
      const label = await enumSelect.locator('..').locator('[class*="label"], label').first().textContent().catch(() => '');
      const isRequired = label?.includes('*') ?? false;

      if (isRequired) {
        const combobox = enumSelect.locator('[role="combobox"], mat-select');
        if (await combobox.count() > 0) {
          const hasValue = await combobox.locator('.mat-mdc-select-value-text, .mat-select-value-text').count() > 0;

          if (!hasValue) {
            await combobox.click();
            await this.page.locator('.mat-mdc-select-panel, .mat-select-panel, [role="listbox"]').waitFor({
              state: 'visible',
              timeout: 5000
            });
            const firstOption = this.page.locator('mat-option').first();
            await firstOption.waitFor({ state: 'visible', timeout: 5000 });
            await firstOption.click();
            await this.page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
          }
        }
      }
    }

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
   * Waits for either success or error UI elements to appear.
   *
   * @param timeout - Maximum time to wait in milliseconds (default: 3 minutes)
   * @returns true if installation succeeded
   * @throws Error if installation failed or timed out
   */
  async waitForInstallationComplete(timeout: number = 180000): Promise<boolean> {
    const successLocator = this.page.locator('[data-testid="installation-success"]');
    const errorLocator = this.page.locator('[data-testid="installation-error"]');

    // Wait for either success or error to appear
    const result = await Promise.race([
      successLocator.waitFor({ state: 'visible', timeout }).then(() => 'success' as const),
      errorLocator.waitFor({ state: 'visible', timeout }).then(() => 'error' as const),
    ]).catch(() => 'timeout' as const);

    if (result === 'success') {
      return true;
    }

    if (result === 'error') {
      const errorText = await errorLocator.textContent().catch(() => 'Unknown error');
      throw new Error(`Installation failed: ${errorText}`);
    }

    throw new Error(`Installation timed out after ${timeout}ms`);
  }

  /**
   * Extract the created container VMID from the process monitor page.
   * Looks for:
   * 1. Success message: "Created container: 301"
   * 2. Command texts: "Create LXC Container 301" or "start LXC 301"
   *
   * @returns The VMID as string, or null if not found
   */
  async extractCreatedVmId(): Promise<string | null> {
    // First, check the success block for "Created container: XXX"
    const successBlock = this.page.locator('[data-testid="installation-success"]');
    if (await successBlock.count() > 0) {
      const successText = await successBlock.textContent();
      if (successText) {
        const containerMatch = successText.match(/Created container:\s*(\d+)/i);
        if (containerMatch) {
          console.log(`Found VMID in success message: ${containerMatch[1]}`);
          return containerMatch[1];
        }
      }
    }

    // Fallback: check command texts
    const commandTexts = this.page.locator('.success-list .command-text');
    const count = await commandTexts.count();

    for (let i = 0; i < count; i++) {
      const text = await commandTexts.nth(i).textContent();
      if (!text) continue;

      // Look for patterns like "Create LXC Container 301" or "start LXC 301"
      const createMatch = text.match(/Create LXC Container\s+(\d+)/i);
      if (createMatch) {
        console.log(`Found VMID in command: ${text}`);
        return createMatch[1];
      }

      const startMatch = text.match(/start LXC\s+(\d+)/i);
      if (startMatch) {
        console.log(`Found VMID in command: ${text}`);
        return startMatch[1];
      }
    }

    console.log('Could not extract VMID from process monitor');
    return null;
  }

  /**
   * Cleanup existing application files before test.
   * Delegates to ApplicationCreateHelper.
   * @param applicationId - Application ID (usually lowercase name with hyphens)
   */
  cleanupApplication(applicationId: string): { success: boolean; message: string } {
    return this.createHelper.cleanupApplicationOnHost(applicationId);
  }

  /**
   * Create a new application via the wizard.
   * Delegates to ApplicationCreateHelper.
   *
   * @param app - The application configuration
   * @param options - Optional settings
   * @param options.installAfterSave - If true, clicks "Save & Install" and navigates to monitor page
   */
  async createApplication(
    app: E2EApplication,
    options: { installAfterSave?: boolean } = {}
  ): Promise<void> {
    await this.createHelper.createApplication(app, options);
  }

  /**
   * Convenience method: Create and install an application in one go.
   * Uses the "Save & Install" button to streamline the process.
   */
  async createAndInstall(app: E2EApplication, _installParams?: Record<string, string>): Promise<void> {
    await this.createHelper.createApplication(app, { installAfterSave: true });
    await this.waitForInstallationComplete();
  }
}
