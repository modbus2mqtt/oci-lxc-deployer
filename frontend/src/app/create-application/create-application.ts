import { CommonModule } from '@angular/common';
import { ChangeDetectorRef, Component, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import {
  AbstractControl,
  AsyncValidatorFn,
  FormBuilder,
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  ValidationErrors,
  Validators,
} from '@angular/forms';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatStepper, MatStepperModule } from '@angular/material/stepper';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Observable, Subject, debounceTime, distinctUntilChanged, of, takeUntil } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

import { IFrameworkName, IParameter, IParameterValue, IPostFrameworkFromImageResponse } from '../../shared/types';
import { VeConfigurationService } from '../ve-configuration.service';
import { CacheService } from '../shared/services/cache.service';
import { DockerComposeService, ComposeService, ParsedComposeData } from '../shared/services/docker-compose.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { ComposeEnvSelectorComponent } from '../shared/components/compose-env-selector/compose-env-selector.component';
import { ParameterGroupComponent } from '../ve-configuration-dialog/parameter-group.component';
import { OciImageStepComponent } from './oci-image-step.component';

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
    MatCardModule,
    MatTooltipModule,
    MatIconModule,
    MatButtonToggleModule,
    ParameterGroupComponent,
    ComposeEnvSelectorComponent,
    OciImageStepComponent
  ],
  templateUrl: './create-application.html',
  styleUrls: ['./create-application.scss']
})
export class CreateApplication implements OnInit, OnDestroy {
  @ViewChild('stepper') stepper!: MatStepper;
  
  private fb = inject(FormBuilder);
  private configService = inject(VeConfigurationService);
  private router = inject(Router);
  private errorHandler = inject(ErrorHandlerService);
  private cacheService = inject(CacheService);
  private composeService = inject(DockerComposeService);
  private cdr = inject(ChangeDetectorRef);

  // Step 1: Framework selection
  frameworks: IFrameworkName[] = [];
  selectedFramework: IFrameworkName | null = null;
  loadingFrameworks = signal(true);
  
  // OCI Image input (only for oci-image framework)
  imageReference = signal('');
  loadingImageAnnotations = signal(false);
  imageError = signal<string | null>(null);
  imageAnnotationsReceived = signal(false);
  private imageInputSubject = new Subject<string>();
  private destroy$ = new Subject<void>();
  private imageAnnotationsTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastAnnotationsResponse: IPostFrameworkFromImageResponse | null = null;

  // OCI framework install mode
  ociInstallMode = signal<'image' | 'compose'>('image');

  // Step 2: Application properties
  appPropertiesForm: FormGroup = this.fb.group({
    name: ['', [Validators.required]],
    applicationId: ['', [Validators.required, Validators.pattern(/^[a-z0-9-]+$/)]],
    description: ['', [Validators.required]],
    url: [''],
    documentation: [''],
    source: [''],
    vendor: [''],
  });
  
  // Application ID validation
  applicationIdError = signal<string | null>(null);
  private applicationIdSubject = new Subject<string>();
  
  // Icon upload
  selectedIconFile: File | null = null;
  iconPreview = signal<string | null>(null);
  iconContent = signal<string | null>(null);

  // Docker Compose specific
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

  // Step 3: Parameters
  parameters: IParameter[] = [];
  parameterForm: FormGroup = this.fb.group({});
  groupedParameters: Record<string, IParameter[]> = {};
  showAdvanced = signal(false);
  loadingParameters = signal(false);

  // Step 4: Summary
  creating = signal(false);
  createError = signal<string | null>(null);
  createErrorStep = signal<number | null>(null); // Step number to navigate to on error

  ngOnInit(): void {
    this.cacheService.preloadAll();
    this.loadFrameworks();
    
    const applicationIdControl = this.appPropertiesForm.get('applicationId');
    if (applicationIdControl) {
      applicationIdControl.setAsyncValidators([this.applicationIdUniqueValidator()]);
    }
    
    this.imageInputSubject.pipe(
      takeUntil(this.destroy$),
      debounceTime(500), // Wait 500ms after user stops typing
      distinctUntilChanged()
    ).subscribe(imageRef => {
      if (imageRef && imageRef.trim()) {
        this.updateOciImageParameter(imageRef);
        this.fetchImageAnnotations(imageRef.trim());
      } else {
        this.imageError.set(null);
        this.loadingImageAnnotations.set(false);
        if (this.parameterForm.get('oci_image')) {
          this.parameterForm.patchValue({ oci_image: '' }, { emitEvent: false });
        }
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

  loadFrameworks(): void {
    this.loadingFrameworks.set(true);
    
    this.cacheService.getFrameworks().subscribe({
      next: (frameworks) => {
        this.frameworks = frameworks;
        this.loadingFrameworks.set(false);
        
        const defaultFramework = frameworks.find(f => f.id === 'oci-image');
        if (defaultFramework && !this.selectedFramework) {
          this.selectedFramework = defaultFramework;
          this.loadParameters(defaultFramework.id);
        }
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to load frameworks', err);
        this.loadingFrameworks.set(false);
      }
    });
  }

  onFrameworkSelected(frameworkId: string): void {
    this.selectedFramework = this.frameworks.find(f => f.id === frameworkId) || null;
    this.imageReference.set('');
    this.imageError.set(null);
    this.loadingImageAnnotations.set(false);
    this.imageAnnotationsReceived.set(false);
    
    if (this.imageAnnotationsTimeout) {
      clearTimeout(this.imageAnnotationsTimeout);
    }
    
    this.parsedComposeData.set(null);
    this.selectedServiceName.set('');
    this.ociInstallMode.set('image');
    
    if (this.selectedFramework) {
      this.loadParameters(frameworkId);
    }
  }

  setOciInstallMode(mode: 'image' | 'compose'): void {
    this.ociInstallMode.set(mode); // Reaktiviert!
    this.parsedComposeData.set(null); // Reaktiviert!
    this.selectedServiceName.set(''); // Reaktiviert!

    if (mode === 'compose') {
      this.ensureComposeControls({ requireComposeFile: true });
    } else {
      this.setComposeFileRequired(false);
      this.updateEnvFileRequirement();
      this.refreshEnvSummary();
    }
  }

  onServiceSelected(serviceName: string): void {
    this.selectedServiceName.set(serviceName ?? '');
    if (this.isOciComposeMode()) {
      this.updateImageFromCompose();
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
        }

        this.updateEnvFileRequirement();
      }
    }
  }

  toggleAdvanced(): void {
    this.showAdvanced.set(!this.showAdvanced());
  }

  hasAdvancedParams(): boolean {
    return this.parameters.some(p => p.advanced);
  }

  get groupNames(): string[] {
    return Object.keys(this.groupedParameters);
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
    if (!this.selectedFramework || this.appPropertiesForm.invalid || this.parameterForm.invalid) {
      return;
    }

    this.creating.set(true);
    this.createError.set(null);
    this.createErrorStep.set(null);

    const parameterValues: { id: string; value: IParameterValue }[] = [];
    for (const param of this.parameters) {
      let value = this.parameterForm.get(param.id)?.value;

      // Extract base64 content if value has file metadata format: file:filename:content:base64content
      if (typeof value === 'string' && value.match(/^file:[^:]+:content:(.+)$/)) {
        const match = value.match(/^file:[^:]+:content:(.+)$/);
        if (match) {
          value = match[1]; // Extract only the base64 content
        }
      }
      
      if (value !== null && value !== undefined && value !== '') {
        parameterValues.push({ id: param.id, value });
      }
    }

    // Ensure docker-compose essentials are not dropped even if backend didn't list them in `parameters`
    if (this.isDockerComposeFramework()) {
      const ensuredIds = ['compose_file', 'env_file', 'volumes'] as const;
      const existing = new Set(parameterValues.map(p => p.id));
      for (const id of ensuredIds) {
        if (existing.has(id)) continue;
        const v = this.parameterForm.get(id)?.value;
        if (v !== null && v !== undefined && String(v).trim() !== '') {
          parameterValues.push({ id, value: v });
        }
      }
    }

    const body = {
      frameworkId: this.selectedFramework.id,
      applicationId: this.appPropertiesForm.get('applicationId')?.value,
      name: this.appPropertiesForm.get('name')?.value,
      description: this.appPropertiesForm.get('description')?.value,
      url: this.appPropertiesForm.get('url')?.value || undefined,
      documentation: this.appPropertiesForm.get('documentation')?.value || undefined,
      source: this.appPropertiesForm.get('source')?.value || undefined,
      vendor: this.appPropertiesForm.get('vendor')?.value || undefined,
      ...(this.selectedIconFile && this.iconContent() && {
        icon: this.selectedIconFile.name,
        iconContent: this.iconContent()!,
      }),
      parameterValues
    };

    this.configService.createApplicationFromFramework(body).subscribe({
      next: (res) => {
        this.creating.set(false);
        if (res.success) {
          alert(`Application "${body.name}" created successfully!`);
          this.router.navigate(['/applications']);
        } else {
          this.createError.set('Failed to create application. Please try again.');
          this.createErrorStep.set(null);
        }
      },
      error: (err: { error?: { error?: string }; message?: string }) => {
        this.creating.set(false);
        
        // Extract error message
        const errorMessage = err?.error?.error || err?.message || 'Failed to create application';
        
        // Determine which step to navigate to based on error
        let targetStep: number | null = null;
        
        // Check for specific error types
        if (errorMessage.includes('already exists') || errorMessage.includes('Application') && errorMessage.includes('exists')) {
          // Application ID already exists - navigate to Step 2 (Application Properties)
          targetStep = 1; // Step index is 0-based, Step 2 is index 1
          this.createError.set(`Application ID "${body.applicationId}" already exists. Please choose a different ID.`);
        } else if (errorMessage.includes('applicationId') || errorMessage.includes('Missing applicationId')) {
          // Application ID related error - navigate to Step 2
          targetStep = 1;
          this.createError.set(errorMessage);
        } else if (errorMessage.includes('name') || errorMessage.includes('Missing name')) {
          // Name related error - navigate to Step 2
          targetStep = 1;
          this.createError.set(errorMessage);
        } else if (errorMessage.includes('parameter') || errorMessage.includes('Parameter')) {
          // Parameter related error - navigate to Step 3 (Parameters)
          targetStep = 2; // Step index is 0-based, Step 3 is index 2
          this.createError.set(errorMessage);
        } else {
          // Generic error - show in Step 4
          this.createError.set(errorMessage);
          targetStep = null;
        }
        
        this.createErrorStep.set(targetStep);
        
        // Don't automatically navigate - let the user decide when to navigate using the button
        // The error will be displayed in Step 4, and the user can click "Go to Step X to Fix" if needed
      }
    });
  }

  navigateToErrorStep(): void {
    const errorStep = this.createErrorStep();
    if (errorStep !== null && this.stepper) {
      // Navigate to the error step
      this.stepper.selectedIndex = errorStep;
      
      // Mark the form field as touched to show validation errors after navigation
      setTimeout(() => {
        if (errorStep === 1) {
          // Step 2 - mark applicationId field as touched if it's an ID error
          const errorMessage = this.createError();
          if (errorMessage && (errorMessage.includes('already exists') || errorMessage.includes('applicationId'))) {
            this.appPropertiesForm.get('applicationId')?.markAsTouched();
          }
        }
        // Don't clear the error immediately - let it stay visible so user can see what to fix
        // The error will be cleared when they try to create again or manually dismiss it
      }, 100);
    }
  }

  clearError(): void {
    this.createError.set(null);
    this.createErrorStep.set(null);
  }

  getImageReferenceTooltip(): string {
    return `Enter an OCI image reference:
• Docker Hub: image:tag or owner/image:tag (e.g., mariadb:latest, nodered/node-red:latest)
• GitHub Container Registry: ghcr.io/owner/image:tag (e.g., ghcr.io/home-assistant/home-assistant:latest)
• Tag is optional and defaults to 'latest' if not specified
The system will automatically fetch metadata from the image and pre-fill application properties.`;
  }

  /**
   * Custom async validator for application ID uniqueness
   */
  applicationIdUniqueValidator(): AsyncValidatorFn {
    return (control: AbstractControl): Observable<ValidationErrors | null> => {
      const applicationId = control.value;
      
      // If empty, don't validate (required validator will handle it)
      if (!applicationId || !applicationId.trim()) {
        return of(null);
      }
      
      // Check against cache
      return this.cacheService.isApplicationIdTaken(applicationId.trim()).pipe(
        map(isTaken => {
          if (isTaken) {
            return { applicationIdTaken: true };
          }
          return null;
        }),
        catchError(() => {
          // On error, don't block the user - validation will happen on submit
          return of(null);
        })
      );
    };
  }

  onApplicationIdInput(event: Event): void {
    const applicationId = (event.target as HTMLInputElement).value;
    this.applicationIdSubject.next(applicationId);
  }

  validateApplicationId(applicationId: string): void {
    if (!applicationId || !applicationId.trim()) {
      this.applicationIdError.set(null);
      return;
    }
    
    this.cacheService.isApplicationIdTaken(applicationId).subscribe({
      next: (isTaken) => {
        if (isTaken) {
          this.applicationIdError.set(`Application ID "${applicationId}" already exists. Please choose a different ID.`);
          this.appPropertiesForm.get('applicationId')?.setErrors({ taken: true });
        } else {
          this.applicationIdError.set(null);
          // Clear 'taken' error if it exists
          const control = this.appPropertiesForm.get('applicationId');
          if (control?.hasError('taken')) {
            const errors = { ...control.errors };
            delete errors['taken'];
            control.setErrors(Object.keys(errors).length > 0 ? errors : null);
          }
        }
      },
      error: () => {
        // On error, don't block the user - validation will happen on submit
        this.applicationIdError.set(null);
      }
    });
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

  // --- CONSOLIDATED: icon handlers used by template ---
  onIconFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];

    if (!file.type.startsWith('image/')) {
      alert('Please select an image file');
      input.value = '';
      return;
    }
    if (file.size > 1024 * 1024) {
      alert('Image file size must be less than 1MB');
      input.value = '';
      return;
    }

    this.selectedIconFile = file;

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      const base64Content = result.split(',')[1] || result;
      this.iconContent.set(base64Content);
      this.iconPreview.set(result);
    };
    reader.onerror = () => {
      alert('Failed to read image file');
      this.selectedIconFile = null;
      this.iconContent.set(null);
      this.iconPreview.set(null);
      input.value = '';
    };
    reader.readAsDataURL(file);
  }

  removeIcon(): void {
    this.selectedIconFile = null;
    this.iconContent.set(null);
    this.iconPreview.set(null);
    this.resetIconFileInput();
  }

  openIconFileDialog(): void {
    const fileInput = document.getElementById('icon-file-input') as HTMLInputElement | null;
    fileInput?.click();
  }

  private resetIconFileInput(): void {
    const fileInput = document.getElementById('icon-file-input') as HTMLInputElement | null;
    if (fileInput) fileInput.value = '';
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

    const imageRef = image.trim();
    if (imageRef === this.imageReference()) return;

    // Set image reference and trigger annotation fetch
    this.imageReference.set(imageRef);
    this.imageInputSubject.next(imageRef); // Triggers debounced fetchImageAnnotations
  
    // ADDED: Also update oci_image parameter immediately
    this.updateOciImageParameter(imageRef);
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

    const serviceEnvs = this.extractServiceEnvs(service.config);
    // required vars (dürfen auch ohne .env / ohne Werte übernommen werden)
    const requiredKeys =
      data.serviceEnvironmentVariablesRequired?.[serviceName] ??
      data.serviceEnvironmentVariables?.[serviceName] ??
      [];

    const envFileValue = this.parameterForm.get('env_file')?.value;
    const envVarsMap = envFileValue
      ? this.composeService.parseEnvFile(envFileValue)
      : new Map<string, string>();

    const serviceDefaults = data.serviceEnvironmentVariableDefaults?.[serviceName] ?? {};

    const lines: string[] = [];
    const seen = new Set<string>();

    // 1) Aus compose/env_file übernehmen (wie bisher), aber Werte auch leer zulassen
    for (const envEntry of serviceEnvs) {
      const [key, composeValue] = this.parseEnvEntry(envEntry);
      if (!key) continue;

      seen.add(key);

      const envValue = envVarsMap.get(key);
      const defaultValue = serviceDefaults[key];

      if (envValue !== undefined) {
        // auch leere Werte übernehmen; nur Defaults weglassen, wenn NICHT required
        if (key in serviceDefaults && envValue === defaultValue && !requiredKeys.includes(key)) continue;
        lines.push(`${key}=${envValue ?? ''}`);
        continue;
      }

      if (composeValue !== undefined) {
        if (key in serviceDefaults && composeValue === defaultValue && !requiredKeys.includes(key)) continue;
        lines.push(envEntry);
      }
    }

    // 2) REQUIRED Keys ergänzen, auch wenn nirgends definiert → KEY=
    for (const key of requiredKeys) {
      if (!key || seen.has(key)) continue;

      const envValue = envVarsMap.get(key);
      // Wenn nicht vorhanden oder leer -> explizit KEY= (gewünscht)
      if (envValue === undefined) lines.push(`${key}=`);
      else lines.push(`${key}=${envValue ?? ''}`);
    }

    if (lines.length > 0) {
      const envsCtrl = this.parameterForm.get('envs');
      if (envsCtrl) {
        const currentValue = envsCtrl.value;
        if (!currentValue || String(currentValue).trim() === '') {
          envsCtrl.patchValue(lines.join('\n'), { emitEvent: false });
        }
      }
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