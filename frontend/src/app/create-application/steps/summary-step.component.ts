import { Component, EventEmitter, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';

import { CreateApplicationStateService } from '../services/create-application-state.service';
import { VeConfigurationService } from '../../ve-configuration.service';
import { IParameterValue } from '../../../shared/types';

@Component({
  selector: 'app-summary-step',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatCardModule
  ],
  template: `
    <div class="summary-step">
      <h2>Review Your Configuration</h2>

      <!-- Application Properties Summary -->
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
          </dl>
        </mat-card-content>
      </mat-card>

      <!-- Parameters Summary -->
      <mat-card>
        <mat-card-header>
          <mat-card-title>Configuration Parameters</mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <!-- ...existing code... -->
        </mat-card-content>
      </mat-card>

      <!-- Error Display and Action Buttons -->
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
      <mat-card class="summary-card">
        <mat-card-header>
          <mat-card-title>Application Summary</mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <p>Framework: {{ state.selectedFramework()?.name }}</p>
          <p>App Name: {{ state.appPropertiesForm.get('name')?.value }}</p>
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [`
    .summary-step {
      padding: 1rem 0;
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
  `]
})
export class SummaryStepComponent {
  readonly state = inject(CreateApplicationStateService);
  private configService = inject(VeConfigurationService);
  private router = inject(Router);

  @Output() navigateToStep = new EventEmitter<number>();
  @Output() applicationCreated = new EventEmitter<void>();

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
