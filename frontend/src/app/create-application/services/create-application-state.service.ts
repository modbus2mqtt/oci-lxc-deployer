import { Injectable, signal, inject } from '@angular/core';
import { FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { Subject } from 'rxjs';

import { IFrameworkName, IParameter, IPostFrameworkFromImageResponse, ITagsConfig } from '../../../shared/types';
import { ComposeService, DockerComposeService, ParsedComposeData } from '../../shared/services/docker-compose.service';
import { ErrorHandlerService } from '../../shared/services/error-handler.service';
import { VeConfigurationService } from '../../ve-configuration.service';

/**
 * State service for Create Application wizard.
 * Holds all shared state (signals, forms) across step components.
 */
@Injectable({ providedIn: 'root' })
export class CreateApplicationStateService {
  private fb = inject(FormBuilder);
  private configService = inject(VeConfigurationService);
  private composeService = inject(DockerComposeService);
  private errorHandler = inject(ErrorHandlerService);

  // ─────────────────────────────────────────────────────────────────────────────
  // Edit mode state
  // ─────────────────────────────────────────────────────────────────────────────
  editMode = signal(false);
  editApplicationId = signal<string | null>(null);
  loadingEditData = signal(false);

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 1: Framework selection
  // ─────────────────────────────────────────────────────────────────────────────
  frameworks = signal<IFrameworkName[]>([]);
  selectedFramework = signal<IFrameworkName | null>(null);
  loadingFrameworks = signal(true);

  // OCI Image input (only for oci-image framework)
  imageReference = signal('');
  loadingImageAnnotations = signal(false);
  imageError = signal<string | null>(null);
  imageAnnotationsReceived = signal(false);
  lastAnnotationsResponse = signal<IPostFrameworkFromImageResponse | null>(null);

  // OCI framework install mode
  ociInstallMode = signal<'image' | 'compose'>('compose');

  // Subjects for debounced input handling
  imageInputSubject = new Subject<string>();
  applicationIdSubject = new Subject<string>();

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 2: Application properties
  // ─────────────────────────────────────────────────────────────────────────────
  appPropertiesForm: FormGroup = this.createAppPropertiesForm();
  applicationIdError = signal<string | null>(null);

  // Icon upload
  selectedIconFile = signal<File | null>(null);
  iconPreview = signal<string | null>(null);
  iconContent = signal<string | null>(null);

  // Tags
  tagsConfig = signal<ITagsConfig | null>(null);
  selectedTags = signal<string[]>([]);

  // ─────────────────────────────────────────────────────────────────────────────
  // Docker Compose specific
  // ─────────────────────────────────────────────────────────────────────────────
  parsedComposeData = signal<ParsedComposeData | null>(null);
  selectedServiceName = signal<string>('');

  // Expose signals for child display
  composeServices = signal<ComposeService[]>([]);
  requiredEnvVars = signal<string[]>([]);
  missingEnvVars = signal<string[]>([]);
  composeProperties = signal<{
    services?: string;
    ports?: string;
    images?: string;
    networks?: string;
    volumes?: string;
  } | null>(null);

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 3: Parameters
  // ─────────────────────────────────────────────────────────────────────────────
  parameters = signal<IParameter[]>([]);
  parameterForm: FormGroup = this.fb.group({});
  groupedParameters = signal<Record<string, IParameter[]>>({});
  showAdvanced = signal(false);
  loadingParameters = signal(false);

  /** Pending values for controls that don't exist yet (set before parameters are loaded) */
  private pendingControlValues: Record<string, string> = {};

  // ─────────────────────────────────────────────────────────────────────────────
  // Step 4: Summary
  // ─────────────────────────────────────────────────────────────────────────────
  creating = signal(false);
  createError = signal<string | null>(null);
  createErrorStep = signal<number | null>(null);

  // ─────────────────────────────────────────────────────────────────────────────
  // Framework helper methods
  // ─────────────────────────────────────────────────────────────────────────────
  isOciImageFramework(): boolean {
    return this.selectedFramework()?.id === 'oci-image';
  }

  isDockerComposeFramework(): boolean {
    return this.selectedFramework()?.id === 'docker-compose';
  }

  isOciComposeMode(): boolean {
    return this.isOciImageFramework() && this.ociInstallMode() === 'compose';
  }

  usesComposeControls(): boolean {
    return this.isDockerComposeFramework() || this.isOciComposeMode();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tag methods
  // ─────────────────────────────────────────────────────────────────────────────
  toggleTag(tagId: string): void {
    const current = this.selectedTags();
    if (current.includes(tagId)) {
      this.selectedTags.set(current.filter(t => t !== tagId));
    } else {
      this.selectedTags.set([...current, tagId]);
    }
  }

  isTagSelected(tagId: string): boolean {
    return this.selectedTags().includes(tagId);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Form creation
  // ─────────────────────────────────────────────────────────────────────────────
  private createAppPropertiesForm(): FormGroup {
    return this.fb.group({
      name: ['', [Validators.required]],
      applicationId: ['', [Validators.required, Validators.pattern(/^[a-z0-9-]+$/)]],
      description: ['', [Validators.required]],
      url: [''],
      documentation: [''],
      source: [''],
      vendor: [''],
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Reset state (for fresh wizard)
  // ─────────────────────────────────────────────────────────────────────────────
  reset(): void {
    // Edit mode
    this.editMode.set(false);
    this.editApplicationId.set(null);
    this.loadingEditData.set(false);

    // Step 1: Framework
    this.selectedFramework.set(null);
    this.loadingFrameworks.set(true);

    // OCI Image
    this.imageReference.set('');
    this.loadingImageAnnotations.set(false);
    this.imageError.set(null);
    this.imageAnnotationsReceived.set(false);
    this.lastAnnotationsResponse.set(null);
    this.ociInstallMode.set('compose');

    // Step 2: App properties
    this.appPropertiesForm = this.createAppPropertiesForm();
    this.applicationIdError.set(null);

    // Icon
    this.selectedIconFile.set(null);
    this.iconPreview.set(null);
    this.iconContent.set(null);

    // Tags
    this.selectedTags.set([]);

    // Docker Compose
    this.parsedComposeData.set(null);
    this.selectedServiceName.set('');
    this.composeServices.set([]);
    this.requiredEnvVars.set([]);
    this.missingEnvVars.set([]);
    this.composeProperties.set(null);

    // Step 3: Parameters
    this.parameters.set([]);
    this.parameterForm = this.fb.group({});
    this.groupedParameters.set({});
    this.showAdvanced.set(false);
    this.loadingParameters.set(false);
    this.pendingControlValues = {};

    // Step 4: Summary
    this.creating.set(false);
    this.createError.set(null);
    this.createErrorStep.set(null);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Clear error
  // ─────────────────────────────────────────────────────────────────────────────
  clearError(): void {
    this.createError.set(null);
    this.createErrorStep.set(null);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Compose/Image Logic - Helper Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Resets form controls to their default values from parameter definitions.
   * @param preserveControls - Control names to skip (not reset)
   */
  private resetControlsToDefaults(preserveControls: string[]): void {
    for (const controlName of Object.keys(this.parameterForm.controls)) {
      if (!preserveControls.includes(controlName)) {
        const param = this.parameters().find(p => p.id === controlName);
        const defaultValue = param?.default ?? '';
        this.parameterForm.get(controlName)?.setValue(defaultValue);
      }
    }
  }

  /**
   * Gets the currently selected service name, falling back to first service.
   */
  getSelectedServiceName(): string {
    const data = this.parsedComposeData();
    return this.selectedServiceName() || data?.services?.[0]?.name || '';
  }

  /**
   * Gets the effective environment variables for the selected service.
   * Combines .env file values with compose environment and defaults.
   */
  getEffectiveEnvsForSelectedService(): Map<string, string> {
    const data = this.parsedComposeData();
    if (!data) return new Map();

    const serviceName = this.getSelectedServiceName();
    if (!serviceName) return new Map();

    const service = data.services.find(s => s.name === serviceName);
    if (!service) return new Map();

    const envFileContent = this.parameterForm.get('env_file')?.value ?? '';
    return this.composeService.getEffectiveServiceEnvironment(
      service.config, data, serviceName, envFileContent
    );
  }

  /**
   * Updates all compose-derived fields for the selected service.
   * Call this after compose file or env file changes.
   */
  private updateFieldsFromComposeService(): void {
    if (!this.isOciComposeMode()) return;

    const data = this.parsedComposeData();
    if (!data || data.services.length === 0) return;

    this.updateImageFromCompose();
    this.updateInitialCommandFromCompose();
    this.updateUserFromCompose();
    this.fillEnvsForSelectedService();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Clear Methods
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Clears fields that will be populated from a new compose file.
   */
  private clearFieldsForNewComposeFile(): void {
    this.resetControlsToDefaults(['compose_file', 'env_file']);

    if (this.isOciComposeMode()) {
      this.imageReference.set('');
    }

    this.parsedComposeData.set(null);
    this.composeServices.set([]);
    this.composeProperties.set(null);
    this.selectedServiceName.set('');
  }

  /**
   * Clears fields that will be populated from a new env file.
   */
  private clearFieldsForNewEnvFile(): void {
    if (this.isOciComposeMode()) {
      this.resetControlsToDefaults(['compose_file', 'env_file']);
    }
  }

  /**
   * Clears fields that will be populated from image annotations.
   */
  clearFieldsForNewImage(): void {
    this.appPropertiesForm.patchValue({
      name: '',
      description: '',
      url: '',
      documentation: '',
      source: '',
      vendor: '',
      applicationId: ''
    });

    this.selectedIconFile.set(null);
    this.iconPreview.set(null);
    this.iconContent.set(null);
    this.selectedTags.set([]);

    this.resetControlsToDefaults(['compose_file', 'env_file', 'volumes']);

    this.imageAnnotationsReceived.set(false);
    this.lastAnnotationsResponse.set(null);
    this.imageError.set(null);
  }

  /**
   * Handles compose file selection, parses it and updates state.
   */
  async onComposeFileSelected(file: File): Promise<void> {
    // Clear fields that will be populated from the new compose file
    this.clearFieldsForNewComposeFile();
    const base64 = await this.readFileAsBase64(file);
    const valueWithMetadata = `file:${file.name}:content:${base64}`;
    this.parameterForm.get('compose_file')?.setValue(valueWithMetadata);

    const parsed = this.composeService.parseComposeFile(valueWithMetadata);
    if (!parsed) return;

    this.parsedComposeData.set(parsed);
    this.composeServices.set(parsed.services);
    this.composeProperties.set(parsed.properties);

    // Fill volumes ONLY if there are volumes AND field is empty
    if (parsed.volumes && parsed.volumes.length > 0) {
      const volumesText = parsed.volumes.join('\n');
      const volumesCtrl = this.parameterForm.get('volumes');
      if (volumesCtrl) {
        const currentValue = volumesCtrl.value;
        if (!currentValue || String(currentValue).trim() === '') {
          volumesCtrl.patchValue(volumesText, { emitEvent: false });
        }
      } else {
        // Control doesn't exist yet - store as pending
        this.pendingControlValues['volumes'] = volumesText;
      }
    }

    if (this.isOciComposeMode() && parsed.services.length > 0) {
      this.selectedServiceName.set(parsed.services[0].name);
      this.updateFieldsFromComposeService();
    }

    this.updateRequiredEnvVars();
    this.updateEnvFileRequirement();
    this.refreshEnvSummary();
  }

  /**
   * Handles env file selection, parses it and updates state.
   */
  async onEnvFileSelected(file: File): Promise<void> {
    this.clearFieldsForNewEnvFile();

    const base64 = await this.readFileAsBase64(file);
    const valueWithMetadata = `file:${file.name}:content:${base64}`;
    this.parameterForm.get('env_file')?.setValue(valueWithMetadata);

    const envVars = this.composeService.parseEnvFile(valueWithMetadata);
    this.updateMissingEnvVars(envVars);
    this.updateEnvFileRequirement();

    // Update fields in next tick to avoid ExpressionChangedAfterItHasBeenCheckedError
    setTimeout(() => this.updateFieldsFromComposeService(), 0);
  }

  /**
   * Fetches image annotations from the registry.
   */
  fetchImageAnnotations(imageRef: string): void {
    const ref = (imageRef ?? '').trim();
    if (!ref) return;

    // Clear fields that will be populated from the new image
    this.clearFieldsForNewImage();

    this.loadingImageAnnotations.set(true);
    this.imageError.set(null);

    const [image, tag = 'latest'] = ref.split(':');

    this.configService.getFrameworkFromImage({ image, tag }).subscribe({
      next: (res: IPostFrameworkFromImageResponse) => {
        this.loadingImageAnnotations.set(false);
        this.imageAnnotationsReceived.set(true);
        this.lastAnnotationsResponse.set(res);
        this.fillFieldsFromAnnotations(res);
      },
      error: (err) => {
        this.loadingImageAnnotations.set(false);
        const msg = err?.error?.error || err?.message || 'Failed to fetch image annotations';
        this.imageError.set(msg);
      }
    });
  }

  /**
   * Fills form fields from image annotations response.
   */
  fillFieldsFromAnnotations(res: IPostFrameworkFromImageResponse): void {
    const defaults = res?.defaults;
    if (!defaults) return;

    const isEmpty = (v: unknown) => v === null || v === undefined || v === '';

    const appProps = defaults.applicationProperties;
    if (appProps) {
      const form = this.appPropertiesForm;
      if (appProps.name && isEmpty(form.get('name')?.value)) form.patchValue({ name: appProps.name }, { emitEvent: false });
      if (appProps.description && isEmpty(form.get('description')?.value)) form.patchValue({ description: appProps.description }, { emitEvent: false });
      if (appProps.url && isEmpty(form.get('url')?.value)) form.patchValue({ url: appProps.url }, { emitEvent: false });
      if (appProps.documentation && isEmpty(form.get('documentation')?.value)) form.patchValue({ documentation: appProps.documentation }, { emitEvent: false });
      if (appProps.source && isEmpty(form.get('source')?.value)) form.patchValue({ source: appProps.source }, { emitEvent: false });
      if (appProps.vendor && isEmpty(form.get('vendor')?.value)) form.patchValue({ vendor: appProps.vendor }, { emitEvent: false });

      if (appProps.applicationId && isEmpty(form.get('applicationId')?.value)) {
        const ctrl = form.get('applicationId');
        ctrl?.patchValue(appProps.applicationId, { emitEvent: false });
        ctrl?.updateValueAndValidity();
      }
    }

    const params = defaults.parameters;
    if (params) {
      for (const [paramId, paramValue] of Object.entries(params)) {
        const ctrl = this.parameterForm.get(paramId);
        if (ctrl && isEmpty(ctrl.value)) ctrl.patchValue(paramValue, { emitEvent: false });
      }
    }

    const img = this.imageReference().trim();
    if (img && this.parameterForm.get('oci_image') && isEmpty(this.parameterForm.get('oci_image')?.value)) {
      this.parameterForm.patchValue({ oci_image: img }, { emitEvent: false });
    }
  }

  /**
   * Updates image reference from compose file for selected service.
   */
  updateImageFromCompose(): void {
    if (!this.isOciComposeMode()) return;

    const data = this.parsedComposeData();
    if (!data) return;

    const serviceName = this.getSelectedServiceName();
    if (!serviceName) return;

    const service = data.services.find((s: ComposeService) => s.name === serviceName);
    const image = service?.config?.['image'];
    if (typeof image !== 'string' || !image.trim()) return;

    // Use effective envs for variable resolution (includes .env + compose defaults)
    const effectiveEnvs = this.getEffectiveEnvsForSelectedService();
    const imageRef = this.composeService.resolveVariables(image.trim(), effectiveEnvs);
    if (imageRef === this.imageReference()) return;

    this.imageReference.set(imageRef);
    this.imageInputSubject.next(imageRef);
    this.updateOciImageParameter(imageRef);
  }

  /**
   * Updates initial command from compose file for selected service.
   * Resolves environment variables like ${VAR:-default} using values from .env file.
   */
  updateInitialCommandFromCompose(): void {
    if (!this.isOciComposeMode()) return;

    const data = this.parsedComposeData();
    if (!data) return;

    const serviceName = this.getSelectedServiceName();
    if (!serviceName) return;

    const service = data.services.find((s: ComposeService) => s.name === serviceName);
    const command = service?.config?.['command'];

    let cmdStr = '';
    if (Array.isArray(command)) {
      cmdStr = command.join(' ');
    } else if (typeof command === 'string') {
      cmdStr = command;
    }

    if (cmdStr && this.parameterForm.get('initial_command')) {
       const effectiveEnvs = this.getEffectiveEnvsForSelectedService();
       const resolvedCmd = this.composeService.resolveVariables(cmdStr, effectiveEnvs);
       this.parameterForm.patchValue({ initial_command: resolvedCmd });
    }
  }

  /**
   * Updates uid/gid from compose file for selected service.
   */
  updateUserFromCompose(): void {
    if (!this.isOciComposeMode()) return;

    const data = this.parsedComposeData();
    if (!data) return;

    const serviceName = this.getSelectedServiceName();
    if (!serviceName) return;

    const service = data.services.find((s: ComposeService) => s.name === serviceName);
    const user = service?.config?.['user'];

    if (typeof user === 'string' || typeof user === 'number') {
        const effectiveEnvs = this.getEffectiveEnvsForSelectedService();
        const resolvedUser = this.composeService.resolveVariables(String(user), effectiveEnvs);
        const parts = resolvedUser.split(':');

        if (parts.length > 0 && parts[0].trim() && this.parameterForm.get('uid')) {
          this.parameterForm.patchValue({ uid: parts[0].trim() });
        }

        if (parts.length > 1 && parts[1].trim() && this.parameterForm.get('gid')) {
          this.parameterForm.patchValue({ gid: parts[1].trim() });
        }
    }
  }

  /**
   * Fills environment variables for selected service.
   */
  fillEnvsForSelectedService(): void {
    if (!this.isOciComposeMode()) return;

    const effectiveEnvs = this.getEffectiveEnvsForSelectedService();
    if (effectiveEnvs.size === 0) return;

    const lines: string[] = [];
    for (const [key, value] of effectiveEnvs.entries()) {
      lines.push(`${key}=${value}`);
    }

    const envsValue = lines.join('\n');
    const envsControl = this.parameterForm.get('envs');

    if (envsControl) {
      // Control exists - set value directly
      envsControl.patchValue(envsValue);
    } else {
      // Control doesn't exist yet - store as pending (will be applied when parameters are loaded)
      this.pendingControlValues['envs'] = envsValue;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Compose control helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Ensures compose_file, env_file, and volumes controls exist.
   */
  ensureComposeControls(opts?: { requireComposeFile?: boolean }): void {
    const requireComposeFile = opts?.requireComposeFile ?? false;

    if (!this.parameterForm.get('compose_file')) {
      this.parameterForm.addControl('compose_file', new FormControl(''));
    }
    this.setComposeFileRequired(requireComposeFile);

    if (!this.parameterForm.get('env_file')) {
      this.parameterForm.addControl('env_file', new FormControl(''));
    }
    if (!this.parameterForm.get('volumes')) {
      this.parameterForm.addControl('volumes', new FormControl(''));
    }
  }

  /**
   * Sets compose_file control as required or not.
   */
  setComposeFileRequired(required: boolean): void {
    const ctrl = this.parameterForm.get('compose_file');
    if (!ctrl) return;

    if (required) ctrl.setValidators([Validators.required]);
    else ctrl.clearValidators();

    ctrl.updateValueAndValidity({ emitEvent: false });
  }

  /**
   * Updates the oci_image parameter form control.
   */
  updateOciImageParameter(imageRef: string): void {
    const v = (imageRef ?? '').trim();
    if (!v) return;
    if (this.parameterForm.get('oci_image')) {
      this.parameterForm.patchValue({ oci_image: v }, { emitEvent: false });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Environment variable helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Updates required environment variables based on parsed compose data.
   */
  updateRequiredEnvVars(): void {
    const data = this.parsedComposeData();
    if (!data) {
      this.requiredEnvVars.set([]);
      this.missingEnvVars.set([]);
      return;
    }

    let vars: string[] = [];
    if (this.isDockerComposeFramework()) {
      vars = data.environmentVariablesRequired ?? data.environmentVariables ?? [];
    } else if (this.isOciComposeMode()) {
      const serviceName = this.getSelectedServiceName();
      if (!serviceName) return;
      vars = data.serviceEnvironmentVariablesRequired?.[serviceName] ?? data.serviceEnvironmentVariables?.[serviceName] ?? [];
    }

    this.requiredEnvVars.set(vars);

    const envFile = this.parameterForm.get('env_file')?.value;
    if (envFile) {
      const envVars = this.composeService.parseEnvFile(envFile);
      this.updateMissingEnvVars(envVars);
    } else {
      this.missingEnvVars.set(vars);
    }
  }

  /**
   * Updates missing environment variables based on provided env vars.
   */
  updateMissingEnvVars(envVars: Map<string, string>): void {
    const missing = this.requiredEnvVars().filter((v: string) => !envVars.has(v) || !envVars.get(v));
    this.missingEnvVars.set(missing);
  }

  /**
   * Updates env_file requirement based on mode and missing vars.
   */
  updateEnvFileRequirement(): void {
    const envCtrl = this.parameterForm.get('env_file');
    if (!envCtrl) return;

    // OCI Image + Compose: .env ist erlaubt NICHT vorhanden zu sein → niemals required
    if (this.isOciComposeMode()) {
      envCtrl.clearValidators();
      envCtrl.updateValueAndValidity({ emitEvent: false });
      return;
    }

    // docker-compose Framework: bestehende "required wenn missing vars" Logik beibehalten
    const shouldRequireEnvFile =
      this.isDockerComposeFramework() &&
      (this.requiredEnvVars()?.length ?? 0) > 0 &&
      (this.missingEnvVars()?.length ?? 0) > 0;

    if (shouldRequireEnvFile) envCtrl.setValidators([Validators.required]);
    else envCtrl.clearValidators();

    envCtrl.updateValueAndValidity({ emitEvent: false });
  }

  /**
   * Refreshes environment variable summary.
   */
  refreshEnvSummary(): void {
    this.updateRequiredEnvVars();
    this.updateEnvFileRequirement();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utility helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Reads a file as base64.
   */
  readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /**
   * Checks if env file is configured.
   */
  envFileConfigured(): boolean {
    const envFileValue = this.parameterForm.get('env_file')?.value;
    return !!envFileValue && String(envFileValue).trim().length > 0;
  }

  /**
   * Returns sorted list of env var keys from env file.
   */
  envVarKeys(): string[] {
    const envFileValue = this.parameterForm.get('env_file')?.value;
    if (!envFileValue) return [];

    const envVarsMap = this.composeService.parseEnvFile(envFileValue);
    return Array.from(envVarsMap.keys()).sort();
  }

  /**
   * Returns env var keys as newline-separated text.
   */
  envVarKeysText(): string {
    return this.envVarKeys().join('\n');
  }

  /**
   * Loads tags configuration from backend.
   */
  loadTagsConfig(): void {
    this.configService.getTagsConfig().subscribe({
      next: (config) => {
        this.tagsConfig.set(config);
      },
      error: (err) => {
        console.error('Failed to load tags config', err);
      }
    });
  }

  /**
   * Sets up the parameter form from current parameters.
   * Groups parameters by template and adds form controls.
   */
  setupParameterForm(): void {
    const grouped: Record<string, IParameter[]> = {};

    for (const param of this.parameters()) {
      const group = param.templatename || 'General';
      if (!grouped[group]) {
        grouped[group] = [];
      }
      grouped[group].push(param);

      // Skip if control already exists (e.g., compose_file, env_file)
      if (this.parameterForm.get(param.id)) {
        continue;
      }

      const validators = param.required ? [Validators.required] : [];
      const defaultValue = param.default !== undefined ? param.default : '';
      this.parameterForm.addControl(param.id, new FormControl(defaultValue, validators));
    }

    // Sort parameters in each group: required first, then optional
    for (const group in grouped) {
      grouped[group] = grouped[group].slice().sort(
        (a, b) => Number(!!b.required) - Number(!!a.required)
      );
    }

    this.groupedParameters.set(grouped);
  }

  /**
   * Loads parameters for a given framework.
   */
  /** Controls to preserve when switching frameworks in compose mode */
  private readonly COMPOSE_PRESERVED_CONTROLS = ['compose_file', 'env_file', 'volumes', 'envs'] as const;

  loadParameters(frameworkId: string): void {
    this.loadingParameters.set(true);
    this.parameters.set([]);

    // Preserve ALL current form values (not just compose controls)
    // This handles going back from Step 3 to Step 2 and then forward again
    const preservedValues: Record<string, unknown> = {};
    for (const controlId of Object.keys(this.parameterForm.controls)) {
      const value = this.parameterForm.get(controlId)?.value;
      if (value !== null && value !== undefined && value !== '') {
        preservedValues[controlId] = value;
      }
    }

    const preserveCompose = this.usesComposeControls();

    this.parameterForm = this.fb.group({});
    this.groupedParameters.set({});

    if (preserveCompose) {
      // re-create controls + validators consistently after reset
      this.ensureComposeControls({ requireComposeFile: true });
      // Restore compose controls that had values
      for (const controlId of this.COMPOSE_PRESERVED_CONTROLS) {
        if (preservedValues[controlId] && !this.parameterForm.get(controlId)) {
          this.parameterForm.addControl(controlId, new FormControl(''));
        }
      }
      // Patch compose controls first
      const composeValues: Record<string, unknown> = {};
      for (const controlId of this.COMPOSE_PRESERVED_CONTROLS) {
        if (preservedValues[controlId]) {
          composeValues[controlId] = preservedValues[controlId];
        }
      }
      this.parameterForm.patchValue(composeValues, { emitEvent: false });
      this.updateEnvFileRequirement();
    }

    this.configService.getFrameworkParameters(frameworkId).subscribe({
      next: (res) => {
        this.parameters.set(res.parameters);
        // Group parameters by template (or use 'General' as default)
        const grouped: Record<string, IParameter[]> = {};
        for (const param of res.parameters) {
          const group = param.templatename || 'General';
          if (!grouped[group]) {
            grouped[group] = [];
          }
          grouped[group].push(param);

          // Don't overwrite preserved controls if they already exist with a value
          if ((this.isDockerComposeFramework() || this.isOciComposeMode()) && this.COMPOSE_PRESERVED_CONTROLS.includes(param.id as typeof this.COMPOSE_PRESERVED_CONTROLS[number])) {
            const existingControl = this.parameterForm.get(param.id);
            if (existingControl && existingControl.value) {
              continue;
            }
          }

          // NOTE: "Neue Property für Textfeld-Validierung" NICHT im Framework-Flow aktivieren.
          // Hier bewusst nur `required` berücksichtigen (Validation soll nur im ve-configuration-dialog laufen).
          const validators = param.required ? [Validators.required] : [];

          const defaultValue = param.default !== undefined ? param.default : '';
          this.parameterForm.addControl(param.id, new FormControl(defaultValue, validators));
        }

        // Apply preserved values from previous form state (e.g., when going back from Step 3 to Step 2)
        for (const [controlId, value] of Object.entries(preservedValues)) {
          const ctrl = this.parameterForm.get(controlId);
          if (ctrl && value !== null && value !== undefined && value !== '') {
            ctrl.patchValue(value, { emitEvent: false });
          }
        }

        // Apply pending values (set before parameters were loaded)
        for (const [controlId, value] of Object.entries(this.pendingControlValues)) {
          const ctrl = this.parameterForm.get(controlId);
          if (ctrl && value) {
            ctrl.patchValue(value, { emitEvent: false });
          }
        }
        this.pendingControlValues = {};

        // Sort parameters in each group: required first, then optional
        for (const group in grouped) {
          grouped[group] = grouped[group].slice().sort(
            (a, b) => Number(!!b.required) - Number(!!a.required)
          );
        }
        this.groupedParameters.set(grouped);
        this.loadingParameters.set(false);

        this.updateEnvFileRequirement();

        if (preserveCompose) {
          setTimeout(() => this.hydrateComposeDataFromForm(), 0);
        }
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to load framework parameters', err);
        this.loadingParameters.set(false);
      }
    });
  }

  /**
   * Hydrates compose data from form values (after framework switch).
   */
  hydrateComposeDataFromForm(): void {
    const composeFileValue = this.parameterForm.get('compose_file')?.value;
    if (composeFileValue && typeof composeFileValue === 'string' && composeFileValue.trim()) {
      const parsed = this.composeService.parseComposeFile(composeFileValue);
      if (parsed) {
        this.parsedComposeData.set(parsed);

        if (this.isOciComposeMode() && parsed.services.length > 0) {
          this.selectedServiceName.set(parsed.services[0].name);
          this.updateFieldsFromComposeService();
        }

        this.updateEnvFileRequirement();
      }
    }
  }
}
