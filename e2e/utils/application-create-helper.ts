import { Page } from '@playwright/test';
import { E2EApplication, UploadFile } from './application-loader';
import { SSHValidator } from './ssh-validator';
import { getPveHost, getLocalPath } from '../fixtures/test-base';
import { readFileSync, existsSync, rmSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load config for SSH port
interface E2EConfig {
  ports: { pveSsh: number };
}
const configPath = join(__dirname, '..', 'config.json');
const e2eConfig: E2EConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
const SSH_PORT = e2eConfig.ports.pveSsh;

/**
 * Page Object for application creation via UI wizard.
 *
 * Encapsulates the navigation logic for:
 * - Creating new applications via the create-application wizard
 * - Cleanup and validation of created applications (local or SSH-based)
 *
 * In local mode (localPath configured), file operations use the local filesystem.
 * In remote mode, operations use SSH to the PVE host.
 *
 * @example
 * ```typescript
 * const helper = new ApplicationCreateHelper(page);
 * await helper.cleanupApplicationOnHost('my-app');
 * await helper.createApplication(app);
 * await helper.validateApplicationFilesOnHost('my-app');
 * ```
 */
export class ApplicationCreateHelper {
  private sshValidator: SSHValidator;
  private remoteAppBasePath = '/root/oci-lxc-deployer/json/applications';
  private localPath: string | undefined;

  constructor(private page: Page) {
    this.localPath = getLocalPath();
    this.sshValidator = new SSHValidator({
      sshHost: getPveHost(),
      sshPort: SSH_PORT,
    });
  }

  /**
   * Get the applications base path (local or remote)
   */
  private getAppBasePath(): string {
    if (this.localPath) {
      // Resolve relative to project root
      return resolve(process.cwd(), this.localPath, 'applications');
    }
    return this.remoteAppBasePath;
  }

  /**
   * Delete existing application directory before test.
   * Uses local fs operations in local mode, SSH otherwise.
   * This ensures a clean state for creating a new application.
   */
  cleanupApplicationOnHost(applicationId: string): { success: boolean; message: string } {
    const appPath = `${this.getAppBasePath()}/${applicationId}`;

    if (this.localPath) {
      // Local mode: use fs operations
      try {
        if (existsSync(appPath)) {
          rmSync(appPath, { recursive: true, force: true });
          console.log(`Cleanup (local): Deleted ${appPath}`);
          return { success: true, message: `Directory ${appPath} deleted locally` };
        }
        console.log(`Cleanup (local): ${appPath} does not exist`);
        return { success: true, message: `Directory ${appPath} did not exist` };
      } catch (error) {
        console.error(`Cleanup (local) failed: ${error}`);
        return { success: false, message: `Failed to delete ${appPath}: ${error}` };
      }
    }

    // Remote mode: use SSH
    const result = this.sshValidator.deleteDirectoryOnHost(appPath);
    console.log(`Cleanup (SSH): ${result.message}`);
    return result;
  }

  /**
   * Validate that application files were created.
   * Uses local fs in local mode, SSH otherwise.
   * Checks for application.json and optionally template.json.
   */
  validateApplicationFilesOnHost(
    applicationId: string,
    hasUploadFiles: boolean = false
  ): { success: boolean; errors: string[] } {
    const appPath = `${this.getAppBasePath()}/${applicationId}`;
    const errors: string[] = [];

    if (this.localPath) {
      // Local mode: use fs operations
      const appJsonPath = join(appPath, 'application.json');
      if (existsSync(appJsonPath)) {
        console.log(`Application JSON check (local): File exists at ${appJsonPath}`);
      } else {
        const msg = `File ${appJsonPath} does not exist`;
        console.log(`Application JSON check (local): ${msg}`);
        errors.push(msg);
      }

      if (hasUploadFiles) {
        const templateJsonPath = join(appPath, 'template.json');
        if (existsSync(templateJsonPath)) {
          console.log(`Template JSON check (local): File exists at ${templateJsonPath}`);
        } else {
          const msg = `File ${templateJsonPath} does not exist`;
          console.log(`Template JSON check (local): ${msg}`);
          errors.push(msg);
        }
      }
    } else {
      // Remote mode: use SSH
      const appJsonCheck = this.sshValidator.validateFileOnHost({
        path: `${appPath}/application.json`,
      });
      console.log(`Application JSON check (SSH): ${appJsonCheck.message}`);
      if (!appJsonCheck.success) {
        errors.push(appJsonCheck.message);
      }

      if (hasUploadFiles) {
        const templateJsonCheck = this.sshValidator.validateFileOnHost({
          path: `${appPath}/template.json`,
        });
        console.log(`Template JSON check (SSH): ${templateJsonCheck.message}`);
        if (!templateJsonCheck.success) {
          errors.push(templateJsonCheck.message);
        }
      }
    }

    return {
      success: errors.length === 0,
      errors,
    };
  }

  /**
   * Navigate to create application page
   */
  async goToCreateApplication(): Promise<void> {
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
    await this.page.waitForFunction(() => {
      const select = document.querySelector('[data-testid="framework-select"]');
      const valueText = select?.querySelector('.mat-mdc-select-value-text');
      return valueText && valueText.textContent && valueText.textContent.includes('oci-image');
    }, { timeout: 15000 });
    console.log('Framework oci-image is selected');

    // Step 3: Wait for compose file input
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

    const option = this.page.locator(`mat-option:has-text("${frameworkId}")`);
    await option.waitFor({ state: 'visible' });
    await option.click();

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

    await this.page.locator('app-icon-upload img, app-icon-upload .icon-preview').first().waitFor({
      state: 'visible',
      timeout: 5000
    }).catch(() => {});
  }

  /**
   * Fill application properties form
   * @param name - Display name for the application
   * @param description - Optional description
   * @param applicationId - Optional explicit application ID (if not set, uses current value or generates from name)
   */
  async fillAppProperties(name: string, description?: string, applicationId?: string): Promise<void> {
    const nameInput = this.page.locator('[data-testid="app-name-input"]').or(
      this.page.locator('input[formControlName="name"]')
    );
    await nameInput.waitFor({ state: 'visible' });
    await nameInput.fill(name);

    const appIdInput = this.page.locator('input[formControlName="applicationId"]');
    await appIdInput.waitFor({ state: 'visible' });

    // Use explicit applicationId if provided, otherwise keep UI-generated value or generate from name
    if (applicationId) {
      await appIdInput.fill(applicationId);
    } else {
      const currentValue = await appIdInput.inputValue();
      if (!currentValue || currentValue.trim() === '') {
        const appId = name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
        await appIdInput.fill(appId);
      }
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
   */
  async selectTags(tags: string[]): Promise<void> {
    if (!tags || tags.length === 0) return;

    const tagsSection = this.page.locator('app-tags-selector');
    await tagsSection.waitFor({ state: 'visible', timeout: 10000 });

    for (const tag of tags) {
      const chipOption = this.page.locator(`mat-chip-option:has-text("${tag}")`);
      if (await chipOption.count() > 0) {
        await chipOption.click();
        await this.page.waitForTimeout(100);
      } else {
        console.warn(`Tag "${tag}" not found in tags selector`);
      }
    }
  }

  /**
   * Configure upload files in the Upload Files step
   */
  async configureUploadFiles(uploadfiles: UploadFile[]): Promise<void> {
    const uploadFilesStep = this.page.locator('[data-testid="upload-files-step"]');
    await uploadFilesStep.waitFor({ state: 'visible', timeout: 10000 });

    for (const file of uploadfiles) {
      await this.page.locator('[data-testid="new-key-input"]').fill(file.filename);
      await this.page.locator('[data-testid="new-value-input"]').fill(file.destination);
      await this.page.locator('[data-testid="add-row-btn"]').click();
      await this.page.waitForTimeout(100);
    }
  }

  /**
   * Click Next button to proceed to next step
   */
  async clickNext(): Promise<void> {
    const nextBtn = this.page.locator('[data-testid="next-step-btn"]:visible');
    await nextBtn.waitFor({ state: 'visible', timeout: 10000 });
    await nextBtn.scrollIntoViewIfNeeded();
    await nextBtn.click();
    await this.page.waitForLoadState('networkidle');
  }

  /**
   * Click Create Application button in summary step
   */
  async clickCreate(): Promise<void> {
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
    await this.goToCreateApplication();

    if (app.dockerCompose) {
      await this.uploadDockerCompose(app.dockerCompose);
    }

    if (app.envFile) {
      await this.uploadEnvFile(app.envFile);
    }

    await this.clickNext();

    await this.fillAppProperties(app.name, app.description, app.applicationId);

    if (app.tags && app.tags.length > 0) {
      await this.selectTags(app.tags);
    }

    if (app.icon) {
      await this.uploadIcon(app.icon);
    }

    await this.clickNext();

    await this.page.waitForLoadState('networkidle');
    await this.clickNext();

    if (app.uploadfiles && app.uploadfiles.length > 0) {
      await this.configureUploadFiles(app.uploadfiles);
    }
    await this.clickNext();

    await this.clickCreate();

    await this.page.waitForLoadState('networkidle');

    const successIndicator = this.page.locator('[data-testid="installation-success"]').or(
      this.page.locator('text=successfully')
    );

    try {
      await successIndicator.waitFor({ timeout: 30000 });
    } catch {
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/applications')) {
        throw new Error('Application creation failed - no success indicator found');
      }
    }
  }
}
