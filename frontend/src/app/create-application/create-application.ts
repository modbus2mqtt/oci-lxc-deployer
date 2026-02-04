import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, ViewChild, inject } from '@angular/core';
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
import { debounceTime, distinctUntilChanged, Subject, takeUntil } from 'rxjs';

import { IFrameworkName, IParameter, IPostFrameworkFromImageResponse } from '../../shared/types';
import { VeConfigurationService } from '../ve-configuration.service';
import { CacheService } from '../shared/services/cache.service';
import { DockerComposeService } from '../shared/services/docker-compose.service';
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
  private destroy$ = new Subject<void>();

  ngOnInit(): void {
    this.cacheService.preloadAll();
    this.loadTagsConfig();

    // Subscribe to debounced image input from state service
    this.state.imageInputSubject.pipe(
      takeUntil(this.destroy$),
      debounceTime(500),
      distinctUntilChanged()
    ).subscribe((imageRef: string) => {
      if (imageRef && imageRef.trim()) {
        this.state.updateOciImageParameter(imageRef);
        // In edit mode, don't fetch annotations automatically - user already has their data
        if (!this.editMode()) {
          this.state.fetchImageAnnotations(imageRef.trim());
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
    // Ensure compose controls exist immediately for docker-compose framework
    // This prevents template errors before loadParameters() completes
    if (this.isDockerComposeFramework()) {
      this.state.ensureComposeControls({ requireComposeFile: true });
    }

    if (this.state.selectedFramework()) {
      this.loadParameters(frameworkId);
    }
  }

  onInstallModeChanged(mode: 'image' | 'compose'): void {
    if (mode === 'compose') {
      this.state.ensureComposeControls({ requireComposeFile: true });
    } else {
      this.state.setComposeFileRequired(false);
      this.state.updateEnvFileRequirement();
      this.state.refreshEnvSummary();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onServiceSelected(_serviceName: string): void {
    if (this.isOciComposeMode()) {
      this.state.updateImageFromCompose();
      this.state.updateInitialCommandFromCompose();
      this.state.updateUserFromCompose();
      this.state.fillEnvsForSelectedService();
    }
    this.state.updateEnvFileRequirement();
  }

  loadParameters(frameworkId: string): void {
    this.loadingParameters.set(true);
    this.parameters = [];

    const preserveCompose = this.state.usesComposeControls();
    const composeFileValue = preserveCompose ? (this.parameterForm.get('compose_file')?.value || '') : '';
    const envFileValue = preserveCompose ? (this.parameterForm.get('env_file')?.value || '') : '';
    const volumesValue = preserveCompose ? (this.parameterForm.get('volumes')?.value || '') : '';

    this.parameterForm = this.fb.group({});
    this.groupedParameters = {};

    if (preserveCompose) {
      // re-create controls + validators consistently after reset
      this.state.ensureComposeControls({ requireComposeFile: true });
      this.parameterForm.patchValue(
        { compose_file: composeFileValue, env_file: envFileValue, volumes: volumesValue },
        { emitEvent: false }
      );
      this.state.updateEnvFileRequirement();
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

        this.state.updateEnvFileRequirement();

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
          this.state.updateImageFromCompose();
          this.state.updateInitialCommandFromCompose();
          this.state.updateUserFromCompose();
        }

        this.state.updateEnvFileRequirement();
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
    const lastResponse = this.state.lastAnnotationsResponse();
    if (event.selectedIndex === 1 && lastResponse) {
      // Use setTimeout to ensure the form is fully rendered
      setTimeout(() => {
        this.state.fillFieldsFromAnnotations(lastResponse);
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

  // Template: (imageReferenceChange)="onImageReferenceChange($event)"
  onImageReferenceChange(imageRef: string): void {
    const v = (imageRef ?? '').trim();
    this.imageReference.set(v);
    this.imageError.set(null);
    this.imageAnnotationsReceived.set(false);
    this.state.imageInputSubject.next(v);
  }

  // Template: (annotationsReceived)="onAnnotationsReceived($event)"
  onAnnotationsReceived(response: IPostFrameworkFromImageResponse): void {
    this.state.lastAnnotationsResponse.set(response);
    this.loadingImageAnnotations.set(false);
    this.imageAnnotationsReceived.set(true);
    setTimeout(() => this.state.fillFieldsFromAnnotations(response), 0);
  }

  // Delegate compose/env file selection to state service
  async onComposeFileSelected(file: File): Promise<void> {
    await this.state.onComposeFileSelected(file);
  }

  async onEnvFileSelected(file: File): Promise<void> {
    await this.state.onEnvFileSelected(file);
  }

  // --- Template helpers for env summary display (delegate to state) ---
  envFileConfigured(): boolean {
    return this.state.envFileConfigured();
  }

  envVarKeys(): string[] {
    return this.state.envVarKeys();
  }

  envVarKeysText(): string {
    return this.state.envVarKeysText();
  }
}
