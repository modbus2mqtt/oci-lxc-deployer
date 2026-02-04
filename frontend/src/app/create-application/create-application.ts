import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
import {
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatChipsModule } from '@angular/material/chips';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Subject, debounceTime, distinctUntilChanged, takeUntil } from 'rxjs';

import { IFrameworkName, IParameter, IPostFrameworkFromImageResponse } from '../../shared/types';
import { VeConfigurationService } from '../ve-configuration.service';
import { CacheService } from '../shared/services/cache.service';
import { DockerComposeService, ComposeService, ParsedComposeData } from '../shared/services/docker-compose.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { CreateApplicationStateService } from './services/create-application-state.service';
import { AppPropertiesStepComponent } from './steps/app-properties-step.component';
import { FrameworkStepComponent } from './steps/framework-step.component';
import { ParametersStepComponent } from './steps/parameters-step.component';
import { SummaryStepComponent } from './steps/summary-step.component';

@Component({
  selector: 'app-create-application',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatStepperModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatTooltipModule,
    MatIconModule,
    MatButtonToggleModule,
    MatChipsModule,
    AppPropertiesStepComponent,
    FrameworkStepComponent,
    ParametersStepComponent,
    SummaryStepComponent
  ],
  templateUrl: './create-application.html',
  styleUrls: ['./create-application.scss']
})
export class CreateApplication implements OnInit, OnDestroy {
  @ViewChild('stepper') stepper!: MatStepper;
  @ViewChild(SummaryStepComponent) summaryStep!: SummaryStepComponent;

  // Inject services
  private fb = inject(FormBuilder);
  private configService = inject(VeConfigurationService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);
  private errorHandler = inject(ErrorHandlerService);
  private cacheService = inject(CacheService);
  private composeService = inject(DockerComposeService);
  private cdr = inject(ChangeDetectorRef);

  // State Service - holds all shared state
  readonly state = inject(CreateApplicationStateService);

  // ─────────────────────────────────────────────────────────────────────────────
  // Delegate to State Service signals
  // ─────────────────────────────────────────────────────────────────────────────

  // Edit mode
  get editMode() { return this.state.editMode; }
  get editApplicationId() { return this.state.editApplicationId; }
  get loadingEditData() { return this.state.loadingEditData; }

  // Step 1: Framework selection
  get frameworks() { return this.state.frameworks(); }
  get selectedFramework() { return this.state.selectedFramework(); }
  set selectedFramework(value: IFrameworkName | null) { this.state.selectedFramework.set(value); }
  get loadingFrameworks() { return this.state.loadingFrameworks; }

  // OCI Image
  get imageReference() { return this.state.imageReference; }
  get loadingImageAnnotations() { return this.state.loadingImageAnnotations; }
  get imageError() { return this.state.imageError; }
  get imageAnnotationsReceived() { return this.state.imageAnnotationsReceived; }

  // OCI install mode
  get ociInstallMode() { return this.state.ociInstallMode; }

  // Step 2: App properties
  get appPropertiesForm() { return this.state.appPropertiesForm; }
  get applicationIdError() { return this.state.applicationIdError; }

  // Icon
  get selectedIconFile() { return this.state.selectedIconFile(); }
  set selectedIconFile(value: File | null) { this.state.selectedIconFile.set(value); }
  get iconPreview() { return this.state.iconPreview; }
  get iconContent() { return this.state.iconContent; }

  // Tags
  get tagsConfig() { return this.state.tagsConfig; }
  get selectedTags() { return this.state.selectedTags; }

  // Docker Compose
  get parsedComposeData() { return this.state.parsedComposeData; }
  get selectedServiceName() { return this.state.selectedServiceName; }
  get composeServices() { return this.state.composeServices; }
  get requiredEnvVars() { return this.state.requiredEnvVars; }
  get missingEnvVars() { return this.state.missingEnvVars; }
  get composeProperties() { return this.state.composeProperties; }

  // Step 3: Parameters
  get parameters() { return this.state.parameters(); }
  set parameters(value: IParameter[]) { this.state.parameters.set(value); }
  get parameterForm() { return this.state.parameterForm; }
  set parameterForm(value: FormGroup) { this.state.parameterForm = value; }
  get groupedParameters() { return this.state.groupedParameters(); }
  set groupedParameters(value: Record<string, IParameter[]>) { this.state.groupedParameters.set(value); }
  get showAdvanced() { return this.state.showAdvanced; }
  get loadingParameters() { return this.state.loadingParameters; }

  // Step 4: Summary
  get creating() { return this.state.creating; }
  get createError() { return this.state.createError; }
  get createErrorStep() { return this.state.createErrorStep; }

  // ─────────────────────────────────────────────────────────────────────────────
  // Local state (component-specific, not shared)
  // ─────────────────────────────────────────────────────────────────────────────
  private imageInputSubject = new Subject<string>();
  private destroy$ = new Subject<void>();
  private imageAnnotationsTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastAnnotationsResponse: IPostFrameworkFromImageResponse | null = null;

  ngOnInit(): void {
    this.cacheService.preloadAll();
    this.loadTagsConfig();

    this.imageInputSubject.pipe(
      takeUntil(this.destroy$),
      debounceTime(500), // Wait 500ms after user stops typing
      distinctUntilChanged()
    ).subscribe(imageRef => {
      if (imageRef && imageRef.trim()) {
        this.updateOciImageParameter(imageRef);
        // In edit mode, don't fetch annotations automatically - user already has their data
        if (!this.editMode()) {
          this.fetchImageAnnotations(imageRef.trim());
        }
      } else {
        this.imageError.set(null);
        this.loadingImageAnnotations.set(false);
        if (this.parameterForm.get('oci_image')) {
          this.parameterForm.patchValue({ oci_image: '' }, { emitEvent: false });
        }
      }
    });

    // Check for edit mode via query parameter
    this.route.queryParams.pipe(takeUntil(this.destroy$)).subscribe(params => {
      const applicationId = params['applicationId'];
      if (applicationId) {
        this.editMode.set(true);
        this.editApplicationId.set(applicationId);
        this.loadEditData(applicationId);
      }
    });
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.imageAnnotationsTimeout) {
      clearTimeout(this.imageAnnotationsTimeout);
    }
  }

  private loadTagsConfig(): void {
    this.configService.getTagsConfig().subscribe({
      next: (config) => {
        this.tagsConfig.set(config);
      },
      error: (err) => {
        console.error('Failed to load tags config', err);
      }
    });
  }

  private loadEditData(applicationId: string): void {
    this.loadingEditData.set(true);

    this.configService.getApplicationFrameworkData(applicationId).subscribe({
      next: (data) => {
        // Set framework
        const framework = this.frameworks.find(f => f.id === data.frameworkId);
        if (framework) {
          this.selectedFramework = framework;

          // Load parameters first, then fill with edit data
          this.configService.getFrameworkParameters(data.frameworkId).subscribe({
            next: (res) => {
              this.parameters = res.parameters;
              this.setupParameterForm();

              // Fill application properties form
              this.appPropertiesForm.patchValue({
                name: data.name,
                applicationId: data.applicationId,
                description: data.description,
                url: data.url || '',
                documentation: data.documentation || '',
                source: data.source || '',
                vendor: data.vendor || '',
              }, { emitEvent: false });

              // Disable applicationId field in edit mode
              this.appPropertiesForm.get('applicationId')?.disable();

              // Fill icon if present
              if (data.iconContent) {
                this.iconContent.set(data.iconContent);
                const iconType = data.icon?.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
                this.iconPreview.set(`data:${iconType};base64,${data.iconContent}`);
              }

              // Fill tags if present
              if (data.tags && data.tags.length > 0) {
                this.selectedTags.set(data.tags);
              }

              // Fill parameter values
              for (const pv of data.parameterValues) {
                const ctrl = this.parameterForm.get(pv.id);
                if (ctrl) {
                  ctrl.patchValue(pv.value, { emitEvent: false });
                }

                // Special handling for oci_image - also set imageReference signal
                if (pv.id === 'oci_image' && typeof pv.value === 'string') {
                  this.imageReference.set(pv.value);
                }

                // Special handling for compose_file - parse it
                if (pv.id === 'compose_file' && typeof pv.value === 'string' && pv.value.trim()) {
                  const parsed = this.composeService.parseComposeFile(pv.value);
                  if (parsed) {
                    this.parsedComposeData.set(parsed);
                    this.composeServices.set(parsed.services);
                    this.composeProperties.set(parsed.properties);
                    if (parsed.services.length > 0) {
                      this.selectedServiceName.set(parsed.services[0].name);
                    }
                    // Set install mode to compose if compose_file is present
                    this.ociInstallMode.set('compose');
                  }
                }
              }

              this.loadingEditData.set(false);

              // Navigate to step 2 after view is ready
              setTimeout(() => {
                if (this.stepper) {
                  this.stepper.selectedIndex = 1;
                }
              }, 100);
            },
            error: (err) => {
              this.errorHandler.handleError('Failed to load framework parameters', err);
              this.loadingEditData.set(false);
            }
          });
        } else {
          this.errorHandler.handleError('Framework not found', new Error(`Framework ${data.frameworkId} not found`));
          this.loadingEditData.set(false);
        }
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to load application data', err);
        this.loadingEditData.set(false);
        // Navigate back to applications list on error
        this.router.navigate(['/applications']);
      }
    });
  }

  private setupParameterForm(): void {
    this.groupedParameters = {};

    for (const param of this.parameters) {
      const group = param.templatename || 'General';
      if (!this.groupedParameters[group]) {
        this.groupedParameters[group] = [];
      }
      this.groupedParameters[group].push(param);

      // Skip if control already exists (e.g., compose_file, env_file)
      if (this.parameterForm.get(param.id)) {
        continue;
      }

      const validators = param.required ? [Validators.required] : [];
      const defaultValue = param.default !== undefined ? param.default : '';
      this.parameterForm.addControl(param.id, new FormControl(defaultValue, validators));
    }

    // Sort parameters in each group: required first, then optional
    for (const group in this.groupedParameters) {
      this.groupedParameters[group] = this.groupedParameters[group].slice().sort(
        (a, b) => Number(!!b.required) - Number(!!a.required)
      );
    }
  }

  onFrameworkSelected(frameworkId: string): void {
    if (this.imageAnnotationsTimeout) {
      clearTimeout(this.imageAnnotationsTimeout);
    }

    // Ensure compose controls exist immediately for docker-compose framework
    // This prevents template errors before loadParameters() completes
    if (this.isDockerComposeFramework()) {
      this.ensureComposeControls({ requireComposeFile: true });
    }

    if (this.state.selectedFramework()) {
      this.loadParameters(frameworkId);
    }
  }

  onInstallModeChanged(mode: 'image' | 'compose'): void {
    if (mode === 'compose') {
      this.ensureComposeControls({ requireComposeFile: true });
    } else {
      this.setComposeFileRequired(false);
      this.updateEnvFileRequirement();
      this.refreshEnvSummary();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onServiceSelected(_serviceName: string): void {
    if (this.isOciComposeMode()) {
      this.updateImageFromCompose();
      this.updateInitialCommandFromCompose();
      this.updateUserFromCompose();
      this.fillEnvsForSelectedService(); // Update envs when service changes
    }
    this.updateEnvFileRequirement();
  }

  loadParameters(frameworkId: string): void {
    this.loadingParameters.set(true);
    this.parameters = [];

    const preserveCompose = this.usesComposeControls();
    const composeFileValue = preserveCompose ? (this.parameterForm.get('compose_file')?.value || '') : '';
    const envFileValue = preserveCompose ? (this.parameterForm.get('env_file')?.value || '') : '';
    const volumesValue = preserveCompose ? (this.parameterForm.get('volumes')?.value || '') : '';

    this.parameterForm = this.fb.group({});
    this.groupedParameters = {};

    if (preserveCompose) {
      // re-create controls + validators consistently after reset
      this.ensureComposeControls({ requireComposeFile: true });
      this.parameterForm.patchValue(
        { compose_file: composeFileValue, env_file: envFileValue, volumes: volumesValue },
        { emitEvent: false }
      );
      this.updateEnvFileRequirement();
    }

    this.configService.getFrameworkParameters(frameworkId).subscribe({
      next: (res) => {
        this.parameters = res.parameters;
        // Group parameters by template (or use 'General' as default)
        this.groupedParameters = {};
        for (const param of this.parameters) {
          const group = param.templatename || 'General';
          if (!this.groupedParameters[group]) {
            this.groupedParameters[group] = [];
          }
          this.groupedParameters[group].push(param);
          
          // Don't overwrite compose_file, env_file, and volumes if they already exist
          if ((this.isDockerComposeFramework() || this.isOciComposeMode()) && (param.id === 'compose_file' || param.id === 'env_file' || param.id === 'volumes')) {
            continue;
          }
          
          // NOTE: "Neue Property für Textfeld-Validierung" NICHT im Framework-Flow aktivieren.
          // Hier bewusst nur `required` berücksichtigen (Validation soll nur im ve-configuration-dialog laufen).
          const validators = param.required ? [Validators.required] : [];

          const defaultValue = param.default !== undefined ? param.default : '';
          this.parameterForm.addControl(param.id, new FormControl(defaultValue, validators));
        }
        // Sort parameters in each group: required first, then optional
        for (const group in this.groupedParameters) {
          this.groupedParameters[group] = this.groupedParameters[group].slice().sort(
            (a, b) => Number(!!b.required) - Number(!!a.required)
          );
        }
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

  private hydrateComposeDataFromForm(): void {
    const composeFileValue = this.parameterForm.get('compose_file')?.value;
    if (composeFileValue && typeof composeFileValue === 'string' && composeFileValue.trim()) {
      const parsed = this.composeService.parseComposeFile(composeFileValue);
      if (parsed) {
        this.parsedComposeData.set(parsed);

        if (this.isOciComposeMode() && parsed.services.length > 0) {
          const first = parsed.services[0].name;
          this.selectedServiceName.set(first);
          this.updateImageFromCompose();
          this.updateInitialCommandFromCompose();
          this.updateUserFromCompose();
        }

        this.updateEnvFileRequirement();
      }
    }
  }

  canProceedToStep2(): boolean {
    if (!this.selectedFramework) {
      return false;
    }
    
    // For oci-image framework
    if (this.isOciImageFramework()) {
      if (this.ociInstallMode() === 'compose') {
        const composeFile = this.parameterForm.get('compose_file')?.value;
        const hasCompose = !!composeFile && String(composeFile).trim().length > 0 && this.parsedComposeData() !== null;
        const hasImage = this.imageReference().trim().length > 0;
        return hasCompose && hasImage;
      }
      return this.imageReference().trim().length > 0;
    }
    
    // For docker-compose framework, require compose_file
    if (this.isDockerComposeFramework()) {
      const composeFile = this.parameterForm.get('compose_file')?.value;
      return composeFile && composeFile.trim().length > 0 && this.parsedComposeData() !== null;
    }
    
    return true;
  }

  onStepChange(event: { selectedIndex: number }): void {
    // When Step 2 is entered, fill fields from annotations if they were already loaded
    if (event.selectedIndex === 1 && this.lastAnnotationsResponse) {
      // Use setTimeout to ensure the form is fully rendered
      setTimeout(() => {
        this.fillFieldsFromAnnotations(this.lastAnnotationsResponse!);
      }, 0);
    }
  }

  canProceedToStep3(): boolean {
    if (this.appPropertiesForm.invalid) {
      this.appPropertiesForm.markAllAsTouched();
      return false;
    }
    return true;
  }

  canProceedToStep4(): boolean {
    if (this.parameterForm.invalid) {
      this.parameterForm.markAllAsTouched();
      return false;
    }
    return true;
  }

  createApplication(): void {
    this.summaryStep.createApplication();
  }

  onNavigateToStep(stepIndex: number): void {
    if (this.stepper) {
      this.stepper.selectedIndex = stepIndex;

      // Mark the form field as touched to show validation errors after navigation
      setTimeout(() => {
        if (stepIndex === 1) {
          // Step 2 - mark applicationId field as touched if it's an ID error
          const errorMessage = this.createError();
          if (errorMessage && (errorMessage.includes('already exists') || errorMessage.includes('applicationId'))) {
            this.appPropertiesForm.get('applicationId')?.markAsTouched();
          }
        }
      }, 100);
    }
  }

  getImageReferenceTooltip(): string {
    return `Enter an OCI image reference:
• Docker Hub: image:tag or owner/image:tag (e.g., mariadb:latest, nodered/node-red:latest)
• GitHub Container Registry: ghcr.io/owner/image:tag (e.g., ghcr.io/home-assistant/home-assistant:latest)
• Tag is optional and defaults to 'latest' if not specified
The system will automatically fetch metadata from the image and pre-fill application properties.`;
  }

  cancel(): void {
    this.router.navigate(['/applications']);
  }

  // --- CONSOLIDATED: framework helpers used by template ---
  isOciImageFramework(): boolean {
    return this.selectedFramework?.id === 'oci-image';
  }

  isDockerComposeFramework(): boolean {
    return this.selectedFramework?.id === 'docker-compose';
  }

  isOciComposeMode(): boolean {
    return this.isOciImageFramework() && this.ociInstallMode() === 'compose';
  }

  private usesComposeControls(): boolean {
    return this.isDockerComposeFramework() || this.isOciComposeMode();
  }

  // --- CONSOLIDATED: env summary + requirement helpers used by template/logic ---
  private ensureComposeControls(opts?: { requireComposeFile?: boolean }): void {
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

  // Template: (imageReferenceChange)="onImageReferenceChange($event)"
  onImageReferenceChange(imageRef: string): void {
    const v = (imageRef ?? '').trim();
    this.imageReference.set(v);
    this.imageError.set(null);
    this.imageAnnotationsReceived.set(false);
    this.imageInputSubject.next(v);
  }

  // Template: (annotationsReceived)="onAnnotationsReceived($event)"
  onAnnotationsReceived(response: IPostFrameworkFromImageResponse): void {
    this.lastAnnotationsResponse = response;
    this.loadingImageAnnotations.set(false);
    this.imageAnnotationsReceived.set(true);
    setTimeout(() => this.fillFieldsFromAnnotations(response), 0);
  }

  // --- add: used by ngOnInit debounce pipeline ---
  private updateOciImageParameter(imageRef: string): void {
    const v = (imageRef ?? '').trim();
    if (!v) return;
    if (this.parameterForm.get('oci_image')) {
      this.parameterForm.patchValue({ oci_image: v }, { emitEvent: false });
    }
  }

  // --- add: used by template output from ComposeEnvSelectorComponent ---
  private isParsedComposeData(x: unknown): x is ParsedComposeData {
    if (!x || typeof x !== 'object') return false;
    const o = x as Record<string, unknown>;
    return 'composeData' in o && 'services' in o;
  }

  private extractParsedComposeData(event: unknown): ParsedComposeData | null {
    if (this.isParsedComposeData(event)) return event;
    const detail = (event as CustomEvent<unknown> | { detail?: unknown } | null | undefined)?.detail;
    if (this.isParsedComposeData(detail)) return detail;
    return null;
  }

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

  private updateRequiredEnvVars(): void {
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

  private updateMissingEnvVars(envVars: Map<string, string>): void {
    const missing = this.requiredEnvVars().filter((v: string) => !envVars.has(v) || !envVars.get(v));
    this.missingEnvVars.set(missing);
  }

  // --- NEW: env_file Requirement abhängig vom Modus steuern ---
  private updateEnvFileRequirement(): void {
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

  // --- NEW: Summary neu berechnen ---
  private refreshEnvSummary(): void {
    this.updateRequiredEnvVars();
    this.updateEnvFileRequirement();
  }

  private readFileAsBase64(file: File): Promise<string> {
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

  // REMOVE: onComposeDataChanged, onEnvVarsChanged (nicht mehr nötig)
  // --- add: used by ngOnInit debounce pipeline ---
  fetchImageAnnotations(imageRef: string): void {
    const ref = (imageRef ?? '').trim();
    if (!ref) return;

    this.loadingImageAnnotations.set(true);
    this.imageError.set(null);

    const [image, tag = 'latest'] = ref.split(':');

    if (this.imageAnnotationsTimeout) clearTimeout(this.imageAnnotationsTimeout);
    this.imageAnnotationsTimeout = setTimeout(() => {
      // allow proceeding; annotations can arrive later
    }, 1000);

    this.configService.getFrameworkFromImage({ image, tag }).subscribe({
      next: (res: IPostFrameworkFromImageResponse) => {
        this.loadingImageAnnotations.set(false);
        this.imageAnnotationsReceived.set(true);
        if (this.imageAnnotationsTimeout) {
          clearTimeout(this.imageAnnotationsTimeout);
          this.imageAnnotationsTimeout = null;
        }
        this.lastAnnotationsResponse = res;
        this.fillFieldsFromAnnotations(res);
      },
      error: (err) => {
        this.loadingImageAnnotations.set(false);
        if (this.imageAnnotationsTimeout) {
          clearTimeout(this.imageAnnotationsTimeout);
          this.imageAnnotationsTimeout = null;
        }
        const msg = err?.error?.error || err?.message || 'Failed to fetch image annotations';
        this.imageError.set(msg);
      }
    });
  }

  // --- add: used by onAnnotationsReceived + fetchImageAnnotations + onStepChange ---
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

  // --- add: used by OCI compose mode to derive image from selected service ---
  private updateImageFromCompose(): void {
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

    // ADDED: Also update oci_image parameter immediately
    this.updateOciImageParameter(imageRef);
  }

  private updateInitialCommandFromCompose(): void {
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

  // Helper to get required variables from command string
  private getCommandVariables(command: string): Set<string> {
    const { vars } = this.composeService.extractVarRefsFromString(command);
    return new Set(vars);
  }

  private updateUserFromCompose(): void {
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

  private setComposeFileRequired(required: boolean): void {
    const ctrl = this.parameterForm.get('compose_file');
    if (!ctrl) return;

    if (required) ctrl.setValidators([Validators.required]);
    else ctrl.clearValidators();

    ctrl.updateValueAndValidity({ emitEvent: false });
  }
  private fillEnvsForSelectedService(): void {
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

  private extractServiceEnvs(serviceConfig: Record<string, unknown>): string[] {
    const envs: string[] = [];
    const environment = serviceConfig['environment'];
    
    if (environment) {
      if (Array.isArray(environment)) {
        for (const envEntry of environment) {
          if (typeof envEntry === 'string') {
            envs.push(envEntry);
          }
        }
      } else if (typeof environment === 'object') {
        for (const [key, value] of Object.entries(environment as Record<string, unknown>)) {
          envs.push(`${key}=${value ?? ''}`);
        }
      }
    }
    
    return envs;
  }

  private parseEnvEntry(envEntry: string): [string | null, string | undefined] {
    const equalIndex = envEntry.indexOf('=');
    if (equalIndex <= 0) return [null, undefined];
    
    const key = envEntry.substring(0, equalIndex).trim();
    const value = envEntry.substring(equalIndex + 1).trim();
    
    return [key, value];
  }

  // --- NEW: Template helpers für env summary anzeige ---
  envFileConfigured(): boolean {
    const envFileValue = this.parameterForm.get('env_file')?.value;
    return !!envFileValue && String(envFileValue).trim().length > 0;
  }

  envVarKeys(): string[] {
    const envFileValue = this.parameterForm.get('env_file')?.value;
    if (!envFileValue) return [];
    
    const envVarsMap = this.composeService.parseEnvFile(envFileValue);
    return Array.from(envVarsMap.keys()).sort();
  }

  envVarKeysText(): string {
    return this.envVarKeys().join('\n');
  }
}