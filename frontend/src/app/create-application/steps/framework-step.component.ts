import { Component, OnInit, OnDestroy, inject, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatCardModule } from '@angular/material/card';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { Subject } from 'rxjs';

import { CreateApplicationStateService } from '../services/create-application-state.service';
import { OciImageStepComponent } from '../oci-image-step.component';
import { ComposeEnvSelectorComponent } from '../../shared/components/compose-env-selector/compose-env-selector.component';
import { IFrameworkName, IPostFrameworkFromImageResponse } from '../../../shared/types';
import { VeConfigurationService } from '../../ve-configuration.service';

@Component({
  selector: 'app-framework-step',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatSelectModule,
    MatCardModule,
    MatButtonToggleModule,
    OciImageStepComponent,
    ComposeEnvSelectorComponent
  ],
  template: `
    <div class="step-content">
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Framework</mat-label>
        <mat-select data-testid="framework-select" (selectionChange)="onFrameworkSelect($event.value)" [value]="state.selectedFramework()?.id">
          @for (framework of frameworks; track framework.id) {
            <mat-option [value]="framework.id">{{ framework.name }} ({{ framework.id }})</mat-option>
          }
        </mat-select>
      </mat-form-field>

      @if (state.isOciImageFramework()) {
        <mat-card class="selected-framework-card">
          <mat-card-content>
            <h3>OCI Install Mode</h3>
            <mat-button-toggle-group
              [value]="state.ociInstallMode()"
              (change)="onInstallModeChange($event.value)"
              aria-label="OCI install mode"
            >
              <mat-button-toggle value="image">OCI Image</mat-button-toggle>
              <mat-button-toggle value="compose">docker-compose.yml + .env</mat-button-toggle>
            </mat-button-toggle-group>
          </mat-card-content>
        </mat-card>

        @if (state.ociInstallMode() === 'image') {
          <app-oci-image-step
            [parameterForm]="state.parameterForm"
            [imageReference]="state.imageReference"
            [loadingImageAnnotations]="state.loadingImageAnnotations"
            [imageError]="state.imageError"
            [imageAnnotationsReceived]="state.imageAnnotationsReceived"
            (imageReferenceChange)="onImageReferenceChange($event)"
            (annotationsReceived)="onAnnotationsReceived($event)"
          ></app-oci-image-step>
        } @else {
          <app-compose-env-selector
            [parameterForm]="state.parameterForm"
            [mode]="'single'"
            [services]="state.composeServices()"
            [selectedServiceName]="state.selectedServiceName()"
            [requiredEnvVars]="state.requiredEnvVars()"
            [missingEnvVars]="state.missingEnvVars()"
            [composeProperties]="state.composeProperties()"
            (composeFileSelected)="onComposeFileSelect($event)"
            (envFileSelected)="onEnvFileSelect($event)"
            (serviceSelected)="onServiceSelect($event)"
          ></app-compose-env-selector>
        }
      }

      @if (state.isDockerComposeFramework()) {
        <app-compose-env-selector
          [parameterForm]="state.parameterForm"
          [mode]="'multi'"
          [services]="state.composeServices()"
          [selectedServiceName]="state.selectedServiceName()"
          [requiredEnvVars]="state.requiredEnvVars()"
          [missingEnvVars]="state.missingEnvVars()"
          [composeProperties]="state.composeProperties()"
          (composeFileSelected)="onComposeFileSelect($event)"
          (envFileSelected)="onEnvFileSelect($event)"
          (serviceSelected)="onServiceSelect($event)"
        ></app-compose-env-selector>
      }
    </div>
  `,
  styles: [`
    .step-content {
      padding: 1rem 0;
    }

    .full-width {
      width: 100%;
    }

    .selected-framework-card {
      margin-bottom: 1rem;
    }

    h3 {
      margin-bottom: 0.5rem;
    }
  `]
})
export class FrameworkStepComponent implements OnInit, OnDestroy {
  readonly state = inject(CreateApplicationStateService);
  private configService = inject(VeConfigurationService);
  private destroy$ = new Subject<void>();

  frameworks: IFrameworkName[] = [];


  // Outputs for parent coordination
  @Output() frameworkSelected = new EventEmitter<string>();
  @Output() installModeChanged = new EventEmitter<'image' | 'compose'>();
  @Output() composeFileSelected = new EventEmitter<File>();
  @Output() envFileSelected = new EventEmitter<File>();
  @Output() serviceSelected = new EventEmitter<string>();
  @Output() imageReferenceChanged = new EventEmitter<string>();
  @Output() annotationsReceived = new EventEmitter<IPostFrameworkFromImageResponse>();

  ngOnInit(): void {
    this.loadFrameworks();
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  loadFrameworks(): void {
    this.state.loadingFrameworks.set(true);
    console.log('[FrameworkStep] Loading frameworks...');

    this.configService.getFrameworkNames().subscribe({
      next: (response) => {
        this.frameworks = response.frameworks;
        this.state.loadingFrameworks.set(false);
        console.log('[FrameworkStep] Frameworks loaded:', this.frameworks.length);

        // Auto-select oci-image framework (unless in edit mode)
        if (!this.state.editMode() && !this.state.selectedFramework()) {
          const defaultFramework = this.frameworks.find(f => f.id === 'oci-image');
          if (defaultFramework) {
            this.state.selectedFramework.set(defaultFramework);
            this.frameworkSelected.emit(defaultFramework.id);
            console.log('[FrameworkStep] Auto-selected:', defaultFramework.id);
          }
        }
      },
      error: (err) => {
        this.state.loadingFrameworks.set(false);
        console.error('[FrameworkStep] Failed to load frameworks:', err);
       }
    });
  }

  onFrameworkSelect(frameworkId: string): void {
    const framework = this.frameworks.find(f => f.id === frameworkId) || null;
    this.state.selectedFramework.set(framework);
    this.state.imageReference.set('');
    this.state.imageError.set(null);
    this.state.loadingImageAnnotations.set(false);
    this.state.imageAnnotationsReceived.set(false);

    this.state.parsedComposeData.set(null);
    this.state.selectedServiceName.set('');
    this.state.ociInstallMode.set('compose');

    if (framework) {
      this.frameworkSelected.emit(frameworkId);
    }
  }

  onInstallModeChange(mode: 'image' | 'compose'): void {
    this.state.ociInstallMode.set(mode);
    this.state.parsedComposeData.set(null);
    this.state.selectedServiceName.set('');
    this.installModeChanged.emit(mode);
  }

  onServiceSelect(serviceName: string): void {
    this.state.selectedServiceName.set(serviceName ?? '');
    this.serviceSelected.emit(serviceName);
  }

  onComposeFileSelect(file: File): void {
    this.composeFileSelected.emit(file);
  }

  onEnvFileSelect(file: File): void {
    this.envFileSelected.emit(file);
  }

  onImageReferenceChange(imageRef: string): void {
    const v = (imageRef ?? '').trim();
    this.state.imageReference.set(v);
    this.state.imageError.set(null);
    this.state.imageAnnotationsReceived.set(false);
    this.imageReferenceChanged.emit(v);
  }

  onAnnotationsReceived(response: IPostFrameworkFromImageResponse): void {
    this.state.lastAnnotationsResponse.set(response);
    this.state.loadingImageAnnotations.set(false);
    this.state.imageAnnotationsReceived.set(true);
    this.annotationsReceived.emit(response);
  }
}
