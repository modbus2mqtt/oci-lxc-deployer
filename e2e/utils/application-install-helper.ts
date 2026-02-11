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
   *
   * @param timeout - Maximum time to wait in milliseconds (default: 3 minutes)
   * @returns true if installation succeeded
   * @throws Error if installation failed or timed out
   */
  async waitForInstallationComplete(timeout: number = 180000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const successBlock = this.page.locator('[data-testid="installation-success"]').or(
        this.page.locator('.success-block, .installation-complete, text=Installation complete')
      );

      if (await successBlock.isVisible()) {
        return true;
      }

      const errorBlock = this.page.locator('[data-testid="installation-error"]').or(
        this.page.locator('.error-block, .installation-error')
      );

      if (await errorBlock.isVisible()) {
        const errorText = await errorBlock.textContent();
        throw new Error(`Installation failed: ${errorText}`);
      }

      await this.page.waitForLoadState('networkidle');
      await this.page.waitForTimeout(2000);
    }

    throw new Error(`Installation timed out after ${timeout}ms`);
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
   */
  async createApplication(app: E2EApplication): Promise<void> {
    await this.createHelper.createApplication(app);
  }

  /**
   * Convenience method: Create and install an application in one go.
   */
  async createAndInstall(app: E2EApplication, installParams?: Record<string, string>): Promise<void> {
    await this.createHelper.createApplication(app);
    await this.installApplication(app.name, installParams);
    await this.waitForInstallationComplete();
  }
}
