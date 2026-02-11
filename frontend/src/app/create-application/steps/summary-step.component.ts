import { Component, EventEmitter, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatTabsModule } from '@angular/material/tabs';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';

import { CreateApplicationStateService } from '../services/create-application-state.service';
import { VeConfigurationService } from '../../ve-configuration.service';
import { IParameter, IParameterValue, IFrameworkApplicationDataBody } from '../../../shared/types';
import { ParameterGroupComponent } from '../../ve-configuration-dialog/parameter-group.component';

@Component({
  selector: 'app-summary-step',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatCardModule,
    MatTabsModule,
    MatProgressSpinnerModule,
    MatIconModule,
    ParameterGroupComponent
  ],
  template: `
    <div class="summary-step">
      <h2>Review Your Configuration</h2>

      <mat-tab-group [(selectedIndex)]="selectedTabIndex">
        <!-- Tab 1: Install Parameters (Main focus) -->
        <mat-tab label="Install Parameters">
          <div class="tab-content">
            @if (loading) {
              <div class="loading-container">
                <mat-spinner diameter="32"></mat-spinner>
                <span>Loading install parameters...</span>
              </div>
            } @else if (error) {
              <div class="error-container">
                <mat-icon>error</mat-icon>
                <span>{{ error }}</span>
                <button mat-button color="primary" (click)="loadInstallParameters()">Retry</button>
              </div>
            } @else if (installParameters.length === 0) {
              <div class="info-container">
                <mat-icon>info</mat-icon>
                <span>No additional parameters required for installation.</span>
              </div>
            } @else {
              <p class="preview-note">These parameters will be shown during installation:</p>

              @if (hasAdvancedParams()) {
                <div class="advanced-toggle">
                  <button mat-button (click)="toggleAdvanced()">
                    {{ showAdvanced ? 'Hide' : 'Show' }} Advanced Parameters
                  </button>
                </div>
              }

              @for (groupName of groupNames; track groupName) {
                <app-parameter-group
                  [groupName]="groupName"
                  [groupedParameters]="installParametersGrouped"
                  [form]="previewForm"
                  [showAdvanced]="showAdvanced"
                ></app-parameter-group>
              }
            }
          </div>
        </mat-tab>

        <!-- Tab 2: Application Data -->
        <mat-tab label="Application Data">
          <div class="tab-content">
            <mat-card>
              <mat-card-header>
                <mat-card-title>Application Properties</mat-card-title>
              </mat-card-header>
              <mat-card-content>
                <dl class="summary-list">
                  <dt>Name:</dt>
                  <dd>{{ state.appPropertiesForm.get('name')?.value }}</dd>

                  <dt>Application ID:</dt>
                  <dd>{{ state.appPropertiesForm.get('applicationId')?.value }}</dd>

                  <dt>Description:</dt>
                  <dd>{{ state.appPropertiesForm.get('description')?.value }}</dd>

                  @if (state.appPropertiesForm.get('url')?.value) {
                    <dt>URL:</dt>
                    <dd>{{ state.appPropertiesForm.get('url')?.value }}</dd>
                  }

                  @if (state.appPropertiesForm.get('documentation')?.value) {
                    <dt>Documentation:</dt>
                    <dd>{{ state.appPropertiesForm.get('documentation')?.value }}</dd>
                  }

                  @if (state.appPropertiesForm.get('source')?.value) {
                    <dt>Source:</dt>
                    <dd>{{ state.appPropertiesForm.get('source')?.value }}</dd>
                  }

                  @if (state.appPropertiesForm.get('vendor')?.value) {
                    <dt>Vendor:</dt>
                    <dd>{{ state.appPropertiesForm.get('vendor')?.value }}</dd>
                  }

                  <dt>Framework:</dt>
                  <dd>{{ state.selectedFramework()?.name }}</dd>

                  @if (state.selectedTags().length > 0) {
                    <dt>Tags:</dt>
                    <dd>{{ state.selectedTags().join(', ') }}</dd>
                  }

                  @if (state.selectedStacktype()) {
                    <dt>Stacktype:</dt>
                    <dd>{{ state.selectedStacktype() }}</dd>
                  }
                </dl>
              </mat-card-content>
            </mat-card>

            @if (getVolumes()) {
              <mat-card data-testid="summary-volumes">
                <mat-card-header>
                  <mat-card-title>Volumes</mat-card-title>
                </mat-card-header>
                <mat-card-content>
                  <ul class="volumes-list">
                    @for (volume of getVolumesArray(); track volume; let i = $index) {
                      <li [attr.data-testid]="'summary-volume-' + i">{{ volume }}</li>
                    }
                  </ul>
                </mat-card-content>
              </mat-card>
            }

            @if (getEnvs()) {
              <mat-card data-testid="summary-envs">
                <mat-card-header>
                  <mat-card-title>Environment Variables</mat-card-title>
                </mat-card-header>
                <mat-card-content>
                  <ul class="envs-list">
                    @for (env of getEnvsArray(); track env; let i = $index) {
                      <li [attr.data-testid]="'summary-env-' + i">{{ env }}</li>
                    }
                  </ul>
                </mat-card-content>
              </mat-card>
            }

            @if (state.uploadFiles().length > 0) {
              <mat-card data-testid="summary-upload-files">
                <mat-card-header>
                  <mat-card-title>Upload Files</mat-card-title>
                </mat-card-header>
                <mat-card-content>
                  <ul class="upload-files-list">
                    @for (file of state.uploadFiles(); track file.filename; let i = $index) {
                      <li [attr.data-testid]="'summary-upload-file-' + i">
                        <strong class="upload-filename">{{ file.filename }}</strong> → {{ file.destination }}
                        @if (file.required) { <span class="required-badge">Required</span> }
                      </li>
                    }
                  </ul>
                </mat-card-content>
              </mat-card>
            }
          </div>
        </mat-tab>
      </mat-tab-group>

      <!-- Error Display -->
      @if (state.createError()) {
        <mat-card class="error-card">
          <mat-card-header>
            <mat-card-title>Error Creating Application</mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <p class="error-message">{{ state.createError() }}</p>
            @if (state.createErrorStep() !== null) {
              <button mat-stroked-button color="primary" (click)="onNavigateToErrorStep()">
                Go to Step {{ (state.createErrorStep() ?? 0) + 1 }} to Fix
              </button>
            }
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: [`
    .summary-step {
      padding: 1rem 0;
    }

    .tab-content {
      padding: 1rem 0;
    }

    .loading-container {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 2rem;
      color: var(--mdc-theme-text-secondary-on-background, rgba(0, 0, 0, 0.6));
    }

    .error-container {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
      background: #ffebee;
      border-radius: 4px;
      color: #c62828;
    }

    .info-container {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 1rem;
      background: #e3f2fd;
      border-radius: 4px;
      color: #1565c0;
    }

    .preview-note {
      color: var(--mdc-theme-text-secondary-on-background, rgba(0, 0, 0, 0.6));
      margin-bottom: 1rem;
      font-style: italic;
    }

    .advanced-toggle {
      margin-bottom: 1rem;
    }

    .summary-list {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.5rem 1rem;
    }

    .summary-list dt {
      font-weight: 500;
    }

    .summary-list dd {
      margin: 0;
    }

    mat-card {
      margin-bottom: 1rem;
    }

    .error-card {
      border: 1px solid #f44336;
    }

    .error-message {
      color: #f44336;
    }

    .upload-files-list,
    .volumes-list,
    .envs-list {
      list-style: none;
      padding: 0;
      margin: 0;
      font-family: monospace;
      font-size: 0.9rem;
    }

    .upload-files-list li,
    .volumes-list li,
    .envs-list li {
      padding: 0.5rem 0;
      border-bottom: 1px solid #eee;
    }

    .upload-files-list li:last-child,
    .volumes-list li:last-child,
    .envs-list li:last-child {
      border-bottom: none;
    }

    .required-badge {
      background: #f44336;
      color: white;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.75rem;
      margin-left: 0.5rem;
    }
  `]
})
export class SummaryStepComponent {
  readonly state = inject(CreateApplicationStateService);
  private configService = inject(VeConfigurationService);
  private router = inject(Router);

  @Output() navigateToStep = new EventEmitter<number>();
  @Output() applicationCreated = new EventEmitter<void>();

  // Install parameters preview state
  installParameters: IParameter[] = [];
  installParametersGrouped: Record<string, IParameter[]> = {};
  previewForm: FormGroup = new FormGroup({});
  loading = false;
  error: string | null = null;
  showAdvanced = false;

  // Tab state
  selectedTabIndex = 0;

  // Called by parent when step becomes active
  loadInstallParameters(): void {
    this.loading = true;
    this.error = null;

    const body = this.buildPreviewRequestBody();
    if (!body) {
      this.loading = false;
      this.error = 'Missing framework selection';
      return;
    }

    this.configService.getPreviewUnresolvedParameters(body).subscribe({
      next: (res) => {
        this.installParameters = res.unresolvedParameters;
        this.installParametersGrouped = this.groupByTemplate(res.unresolvedParameters);
        this.previewForm = this.buildReadonlyForm(res.unresolvedParameters);
        this.loading = false;
      },
      error: (err) => {
        this.error = err?.error?.error || err?.message || 'Failed to load install parameters';
        this.loading = false;
      }
    });
  }

  private buildPreviewRequestBody(): IFrameworkApplicationDataBody | null {
    const selectedFramework = this.state.selectedFramework();
    if (!selectedFramework) {
      return null;
    }

    const parameterValues: { id: string; value: IParameterValue }[] = [];
    for (const param of this.state.parameters()) {
      let value = this.state.parameterForm.get(param.id)?.value;

      // Extract base64 content if value has file metadata format
      if (typeof value === 'string' && value.match(/^file:[^:]+:content:(.+)$/)) {
        const match = value.match(/^file:[^:]+:content:(.+)$/);
        if (match) {
          value = match[1];
        }
      }

      if (value !== null && value !== undefined && value !== '') {
        parameterValues.push({ id: param.id, value });
      }
    }

    // Ensure docker-compose essentials are not dropped
    if (this.state.isDockerComposeFramework()) {
      const ensuredIds = ['compose_file', 'env_file', 'volumes'] as const;
      const existing = new Set(parameterValues.map(p => p.id));
      for (const id of ensuredIds) {
        if (existing.has(id)) continue;
        const v = this.state.parameterForm.get(id)?.value;
        if (v !== null && v !== undefined && String(v).trim() !== '') {
          parameterValues.push({ id, value: v });
        }
      }
    }

    return {
      frameworkId: selectedFramework.id,
      name: this.state.appPropertiesForm.get('name')?.value || '',
      description: this.state.appPropertiesForm.get('description')?.value || '',
      url: this.state.appPropertiesForm.get('url')?.value || undefined,
      documentation: this.state.appPropertiesForm.get('documentation')?.value || undefined,
      source: this.state.appPropertiesForm.get('source')?.value || undefined,
      vendor: this.state.appPropertiesForm.get('vendor')?.value || undefined,
      tags: this.state.selectedTags().length > 0 ? this.state.selectedTags() : undefined,
      stacktype: this.state.selectedStacktype() ?? undefined,
      parameterValues,
      uploadfiles: this.state.uploadFiles().length > 0 ? this.state.uploadFiles() : undefined,
    };
  }

  private groupByTemplate(params: IParameter[]): Record<string, IParameter[]> {
    const grouped: Record<string, IParameter[]> = {};
    for (const param of params) {
      const group = param.templatename || 'General';
      if (!grouped[group]) {
        grouped[group] = [];
      }
      grouped[group].push(param);
    }
    // Sort: required first
    for (const group in grouped) {
      grouped[group] = grouped[group].slice().sort(
        (a, b) => Number(!!b.required) - Number(!!a.required)
      );
    }
    return grouped;
  }

  private buildReadonlyForm(params: IParameter[]): FormGroup {
    const group: Record<string, FormControl> = {};
    for (const param of params) {
      group[param.id] = new FormControl({
        value: param.default ?? '',
        disabled: true
      });
    }
    return new FormGroup(group);
  }

  get groupNames(): string[] {
    return Object.keys(this.installParametersGrouped);
  }

  // Helper methods for volumes and envs display
  getVolumes(): string {
    return this.state.parameterForm.get('volumes')?.value || '';
  }

  getVolumesArray(): string[] {
    const volumes = this.getVolumes();
    if (!volumes) return [];
    return volumes.split('\n').filter((v: string) => v.trim());
  }

  getEnvs(): string {
    return this.state.parameterForm.get('envs')?.value || '';
  }

  getEnvsArray(): string[] {
    const envs = this.getEnvs();
    if (!envs) return [];
    return envs.split('\n').filter((e: string) => e.trim());
  }

  hasAdvancedParams(): boolean {
    return this.installParameters.some(p => p.advanced);
  }

  toggleAdvanced(): void {
    this.showAdvanced = !this.showAdvanced;
  }

  createApplication(): void {
    const selectedFramework = this.state.selectedFramework();
    if (!selectedFramework || this.state.appPropertiesForm.invalid || this.state.parameterForm.invalid) {
      return;
    }

    this.state.creating.set(true);
    this.state.createError.set(null);
    this.state.createErrorStep.set(null);

    const parameterValues: { id: string; value: IParameterValue }[] = [];
    for (const param of this.state.parameters()) {
      let value = this.state.parameterForm.get(param.id)?.value;

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
    if (this.state.isDockerComposeFramework()) {
      const ensuredIds = ['compose_file', 'env_file', 'volumes'] as const;
      const existing = new Set(parameterValues.map(p => p.id));
      for (const id of ensuredIds) {
        if (existing.has(id)) continue;
        const v = this.state.parameterForm.get(id)?.value;
        if (v !== null && v !== undefined && String(v).trim() !== '') {
          parameterValues.push({ id, value: v });
        }
      }
    }

    const selectedIconFile = this.state.selectedIconFile();
    const iconContent = this.state.iconContent();

    // In edit mode, use getRawValue() to get disabled field value
    const applicationId = this.state.editMode()
      ? this.state.editApplicationId()
      : this.state.appPropertiesForm.get('applicationId')?.value;

    const body = {
      frameworkId: selectedFramework.id,
      applicationId,
      name: this.state.appPropertiesForm.get('name')?.value,
      description: this.state.appPropertiesForm.get('description')?.value,
      url: this.state.appPropertiesForm.get('url')?.value || undefined,
      documentation: this.state.appPropertiesForm.get('documentation')?.value || undefined,
      source: this.state.appPropertiesForm.get('source')?.value || undefined,
      vendor: this.state.appPropertiesForm.get('vendor')?.value || undefined,
      ...(selectedIconFile && iconContent && {
        icon: selectedIconFile.name,
        iconContent: iconContent,
      }),
      // In edit mode, preserve existing icon if no new one selected
      ...(!selectedIconFile && iconContent && this.state.editMode() && {
        iconContent: iconContent,
      }),
      ...(this.state.selectedTags().length > 0 && { tags: this.state.selectedTags() }),
      ...(this.state.selectedStacktype() && { stacktype: this.state.selectedStacktype() ?? undefined }),
      parameterValues,
      ...(this.state.uploadFiles().length > 0 && { uploadfiles: this.state.uploadFiles() }),
      ...(this.state.editMode() && { update: true }),
    };

    const actionText = this.state.editMode() ? 'updated' : 'created';
    this.configService.createApplicationFromFramework(body).subscribe({
      next: (res) => {
        this.state.creating.set(false);
        if (res.success) {
          alert(`Application "${body.name}" ${actionText} successfully!`);
          this.applicationCreated.emit();
          this.router.navigate(['/applications']);
        } else {
          this.state.createError.set(`Failed to ${this.state.editMode() ? 'update' : 'create'} application. Please try again.`);
          this.state.createErrorStep.set(null);
        }
      },
      error: (err: { error?: { error?: string }; message?: string }) => {
        this.state.creating.set(false);

        // Extract error message
        const errorMessage = err?.error?.error || err?.message || 'Failed to create application';

        // Determine which step to navigate to based on error
        let targetStep: number | null = null;

        // Check for specific error types
        if (errorMessage.includes('already exists') || errorMessage.includes('Application') && errorMessage.includes('exists')) {
          // Application ID already exists - navigate to Step 2 (Application Properties)
          targetStep = 1; // Step index is 0-based, Step 2 is index 1
          this.state.createError.set(`Application ID "${body.applicationId}" already exists. Please choose a different ID.`);
        } else if (errorMessage.includes('applicationId') || errorMessage.includes('Missing applicationId')) {
          // Application ID related error - navigate to Step 2
          targetStep = 1;
          this.state.createError.set(errorMessage);
        } else if (errorMessage.includes('name') || errorMessage.includes('Missing name')) {
          // Name related error - navigate to Step 2
          targetStep = 1;
          this.state.createError.set(errorMessage);
        } else if (errorMessage.includes('parameter') || errorMessage.includes('Parameter')) {
          // Parameter related error - navigate to Step 3 (Parameters)
          targetStep = 2; // Step index is 0-based, Step 3 is index 2
          this.state.createError.set(errorMessage);
        } else {
          // Generic error - show in Step 4
          this.state.createError.set(errorMessage);
          targetStep = null;
        }

        this.state.createErrorStep.set(targetStep);

        // Don't automatically navigate - let the user decide when to navigate using the button
        // The error will be displayed in Step 4, and the user can click "Go to Step X to Fix" if needed
      }
    });
  }

  onNavigateToErrorStep(): void {
    const errorStep = this.state.createErrorStep();
    if (errorStep !== null) {
      this.navigateToStep.emit(errorStep);
    }
  }

  clearError(): void {
    this.state.clearError();
  }
}
