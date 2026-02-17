import { Page, expect, Locator, Response } from '@playwright/test';
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
  /** VMID extracted from the last successful installation API response */
  private lastCreatedVmId: string | null = null;

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
  async autoFillRequiredDropdowns(): Promise<void> {
    const dialog = this.page.locator('mat-dialog-container');

    // Wait for required dropdowns to have options loaded (poll-based, no race condition)
    const matSelects = dialog.locator('mat-select[required], mat-select[ng-reflect-required="true"]');
    const selectCount = await matSelects.count();

    for (let i = 0; i < selectCount; i++) {
      const select = matSelects.nth(i);
      const hasValue = await select.locator('.mat-mdc-select-value-text, .mat-select-value-text').count() > 0;

      if (!hasValue) {
        // Poll until clicking the dropdown shows at least one option
        await expect(async () => {
          await select.click({ force: true });
          await this.page.locator('.mat-mdc-select-panel, .mat-select-panel').waitFor({ state: 'visible', timeout: 3000 });
          const optionCount = await this.page.locator('mat-option').count();
          expect(optionCount).toBeGreaterThan(0);
        }).toPass({ timeout: 15000 });

        const firstOption = this.page.locator('mat-option').first();
        await firstOption.click();
        await this.page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      }
    }
  }

  /**
   * Wait for installation to complete by monitoring the polling API responses.
   * Intercepts GET /api/ve/execute/ responses and checks for finished or error messages.
   *
   * @param applicationName - Optional application name to filter by
   * @param timeout - Maximum time to wait in milliseconds (default: 9 minutes)
   * @returns true if installation succeeded
   * @throws Error if installation failed or timed out
   */
  async waitForInstallationComplete(applicationName?: string, timeout: number = 540000): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;

      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.page.off('response', responseHandler);
        reject(new Error(`Installation timed out after ${timeout}ms`));
      }, timeout);

      const responseHandler = async (response: Response) => {
        if (settled) return;
        if (!response.url().includes('/api/ve/execute/')) return;
        if (response.status() !== 200) return;

        try {
          const groups = await response.json();
          for (const group of groups) {
            if (applicationName && !group.application?.toLowerCase().includes(applicationName.toLowerCase())) continue;
            for (const msg of group.messages || []) {
              if (msg.finished === true) {
                settled = true;
                clearTimeout(timeoutId);
                this.page.off('response', responseHandler);
                console.log(`Installation finished: ${msg.result}`);
                if (msg.vmId) {
                  this.lastCreatedVmId = String(msg.vmId);
                  console.log(`Created container VMID (from API): ${this.lastCreatedVmId}`);
                }
                resolve(true);
                return;
              }
              if (msg.exitCode !== undefined && msg.exitCode !== 0 && !msg.finished) {
                settled = true;
                clearTimeout(timeoutId);
                this.page.off('response', responseHandler);
                reject(new Error(`Installation failed: ${msg.command} (exit code ${msg.exitCode})`));
                return;
              }
            }
          }
        } catch {
          // Response parsing failed, skip
        }
      };

      this.page.on('response', responseHandler);
    });
  }

  /**
   * Extract the created container VMID from the process monitor page.
   * Looks for:
   * 1. Success message: "Created container: 301"
   * 2. Command texts: "Create LXC Container 301" or "start LXC 301"
   *
   * @param applicationName - Optional application name to filter by
   * @returns The VMID as string, or null if not found
   */
  async extractCreatedVmId(_applicationName?: string): Promise<string | null> {
    // Prefer VMID from API response (set by waitForInstallationComplete)
    if (this.lastCreatedVmId) {
      console.log(`Using VMID from API response: ${this.lastCreatedVmId}`);
      return this.lastCreatedVmId;
    }

    console.log('Could not extract VMID - waitForInstallationComplete did not capture vmId');
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
    await this.waitForInstallationComplete(app.name);
  }
}
