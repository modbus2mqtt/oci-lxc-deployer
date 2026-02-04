import { Injectable, signal, inject } from '@angular/core';
import { FormBuilder, FormControl, FormGroup, Validators } from '@angular/forms';
import { Subject } from 'rxjs';

import { IFrameworkName, IParameter, IPostFrameworkFromImageResponse, ITagsConfig } from '../../../shared/types';
import { ComposeService, DockerComposeService, ParsedComposeData } from '../../shared/services/docker-compose.service';
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
  // Compose/Image Logic (Phase 8)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Handles compose file selection, parses it and updates state.
   */
  async onComposeFileSelected(file: File): Promise<void> {
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
      const volumesCtrl = this.parameterForm.get('volumes');
      if (volumesCtrl) {
        const currentValue = volumesCtrl.value;
        if (!currentValue || String(currentValue).trim() === '') {
          const volumesText = parsed.volumes.join('\n');
          volumesCtrl.patchValue(volumesText, { emitEvent: false });
        }
      }
    }

    if (this.isOciComposeMode() && parsed.services.length > 0) {
      this.selectedServiceName.set(parsed.services[0].name);
      this.updateImageFromCompose();
      this.updateInitialCommandFromCompose();
      this.updateUserFromCompose();
      this.fillEnvsForSelectedService();
    }

    this.updateRequiredEnvVars();
    this.updateEnvFileRequirement();
    this.refreshEnvSummary();
  }

  /**
   * Handles env file selection, parses it and updates state.
   */
  async onEnvFileSelected(file: File): Promise<void> {
    const base64 = await this.readFileAsBase64(file);
    const valueWithMetadata = `file:${file.name}:content:${base64}`;
    this.parameterForm.get('env_file')?.setValue(valueWithMetadata);

    const envVars = this.composeService.parseEnvFile(valueWithMetadata);
    this.updateMissingEnvVars(envVars);
    this.updateEnvFileRequirement();

    if (this.isOciComposeMode()) {
      this.fillEnvsForSelectedService();
      // Re-resolve image in case .env contains version override
      this.updateImageFromCompose();
      // Update uid/gid in next tick to avoid ExpressionChangedAfterItHasBeenCheckedError
      setTimeout(() => this.updateUserFromCompose(), 0);
    }
  }

  /**
   * Fetches image annotations from the registry.
   */
  fetchImageAnnotations(imageRef: string): void {
    const ref = (imageRef ?? '').trim();
    if (!ref) return;

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

    const serviceName = this.selectedServiceName() || data.services?.[0]?.name || '';
    if (!serviceName) return;

    const service = data.services.find((s: ComposeService) => s.name === serviceName);
    const image = service?.config?.['image'];
    if (typeof image !== 'string' || !image.trim()) return;

    // Get current env values from .env file if uploaded
    const envFileValue = this.parameterForm.get('env_file')?.value;
    const envValues = envFileValue ? this.composeService.parseEnvFile(envFileValue) : new Map<string, string>();

    // Resolve variables like ${ZITADEL_VERSION:-v4.10.1} using env values and defaults
    const imageRef = this.composeService.resolveVariables(image.trim(), envValues);
    if (imageRef === this.imageReference()) return;

    // Set image reference and trigger annotation fetch
    this.imageReference.set(imageRef);
    this.imageInputSubject.next(imageRef); // Triggers debounced fetchImageAnnotations

    // Also update oci_image parameter immediately
    this.updateOciImageParameter(imageRef);
  }

  /**
   * Updates initial command from compose file for selected service.
   */
  updateInitialCommandFromCompose(): void {
    if (!this.isOciComposeMode()) return;

    const data = this.parsedComposeData();
    if (!data) return;

    const serviceName = this.selectedServiceName() || data.services?.[0]?.name || '';
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
       this.parameterForm.patchValue({ initial_command: cmdStr }, { emitEvent: false });
    }
  }

  /**
   * Updates uid/gid from compose file for selected service.
   */
  updateUserFromCompose(): void {
    if (!this.isOciComposeMode()) return;

    const data = this.parsedComposeData();
    if (!data) return;

    const serviceName = this.selectedServiceName() || data.services?.[0]?.name || '';
    if (!serviceName) return;

    const service = data.services.find((s: ComposeService) => s.name === serviceName);
    const user = service?.config?.['user'];

    if (typeof user === 'string' || typeof user === 'number') {
        // Resolve variables in user string
        const envFileContent = this.parameterForm.get('env_file')?.value ?? '';
        const effectiveEnvs = this.composeService.getEffectiveServiceEnvironment(service!.config, data, serviceName, envFileContent);

        // Manual substitution
        let resolvedUser = String(user);
        for(const [key, value] of effectiveEnvs.entries()) {
            resolvedUser = resolvedUser.replace(`\${${key}}`, value);
        }

        const parts = resolvedUser.split(':');

        // Map first part to uid
        if (parts.length > 0 && parts[0].trim()) {
             if (this.parameterForm.get('uid')) {
                 this.parameterForm.patchValue({ uid: parts[0].trim() }, { emitEvent: false });
             }
        }

        // Map second part to gid
        if (parts.length > 1 && parts[1].trim()) {
             if (this.parameterForm.get('gid')) {
                 this.parameterForm.patchValue({ gid: parts[1].trim() }, { emitEvent: false });
             }
        }
    }
  }

  /**
   * Fills environment variables for selected service.
   */
  fillEnvsForSelectedService(): void {
    const data = this.parsedComposeData();
    if (!data || !this.isOciComposeMode()) return;

    const serviceName = this.selectedServiceName() || data.services?.[0]?.name || '';
    if (!serviceName) return;

    const service = data.services.find(s => s.name === serviceName);
    if (!service) return;

    const envFileContent = this.parameterForm.get('env_file')?.value ?? '';
    const effectiveEnvs = this.composeService.getEffectiveServiceEnvironment(service.config, data, serviceName, envFileContent);

    const lines: string[] = [];
    for (const [key, value] of effectiveEnvs.entries()) {
        lines.push(`${key}=${value}`);
    }

    const envsCtrl = this.parameterForm.get('envs');
    if (envsCtrl) {
      envsCtrl.patchValue(lines.join('\n'), { emitEvent: false });
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
      const serviceName = this.selectedServiceName() || data.services?.[0]?.name || '';
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
}
