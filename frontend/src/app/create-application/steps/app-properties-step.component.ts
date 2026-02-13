import { Component, OnInit, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, AsyncValidatorFn, AbstractControl, ValidationErrors } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Observable, Subject, of } from 'rxjs';
import { map, catchError, takeUntil } from 'rxjs/operators';

import { CreateApplicationStateService } from '../services/create-application-state.service';
import { IconUploadComponent, IconSelectedEvent } from '../components/icon-upload.component';
import { TagsSelectorComponent } from '../components/tags-selector.component';
import { CacheService } from '../../shared/services/cache.service';
import { VeConfigurationService } from '../../ve-configuration.service';
import { ITagsConfig } from '../../../shared/types';

@Component({
  selector: 'app-properties-step',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    IconUploadComponent,
    TagsSelectorComponent
  ],
  template: `
    <div class="step-content">
      <form [formGroup]="appPropertiesForm">
        <!-- Name, ID, Description -->
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Application Name</mat-label>
          <input matInput formControlName="name" data-testid="app-name-input" required />
          @if (appPropertiesForm.get('name')?.hasError('required') && appPropertiesForm.get('name')?.touched) {
            <mat-error>Application name is required</mat-error>
          }
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Application ID</mat-label>
          <input matInput formControlName="applicationId" data-testid="app-id-input" required (input)="onApplicationIdInput($event)" />
          <mat-hint>Lowercase letters, numbers, and hyphens only</mat-hint>
          @if (appPropertiesForm.get('applicationId')?.hasError('required') && appPropertiesForm.get('applicationId')?.touched) {
            <mat-error>Application ID is required</mat-error>
          }
          @if (appPropertiesForm.get('applicationId')?.hasError('pattern') && appPropertiesForm.get('applicationId')?.touched) {
            <mat-error>Only lowercase letters, numbers, and hyphens are allowed</mat-error>
          }
          @if (appPropertiesForm.get('applicationId')?.hasError('applicationIdTaken') && appPropertiesForm.get('applicationId')?.touched) {
            <mat-error>Application ID already exists</mat-error>
          }
          @if (appPropertiesForm.get('applicationId')?.pending) {
            <mat-hint align="end">Checking availability...</mat-hint>
          }
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Description</mat-label>
          <textarea matInput formControlName="description" data-testid="app-description-input" required rows="3"></textarea>
          @if (appPropertiesForm.get('description')?.hasError('required') && appPropertiesForm.get('description')?.touched) {
            <mat-error>Description is required</mat-error>
          }
        </mat-form-field>

        <!-- Optional metadata fields -->
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>URL</mat-label>
          <input matInput formControlName="url" />
          <mat-hint>Optional: Link to more information</mat-hint>
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Documentation URL</mat-label>
          <input matInput formControlName="documentation" />
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Source URL</mat-label>
          <input matInput formControlName="source" />
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Vendor</mat-label>
          <input matInput formControlName="vendor" />
        </mat-form-field>

        <!-- Stacktype Selection -->
        @if (state.stacktypes().length > 0) {
          <mat-form-field appearance="outline" class="full-width">
            <mat-label>Stacktype</mat-label>
            <mat-select [value]="state.selectedStacktype()" (selectionChange)="onStacktypeChange($event.value)">
              <mat-option [value]="null">-- No Stacktype --</mat-option>
              @for (st of state.stacktypes(); track st.name) {
                <mat-option [value]="st.name">{{ st.name }}</mat-option>
              }
            </mat-select>
            <mat-hint>Optional: Link to a stack for shared environment variables</mat-hint>
          </mat-form-field>
        }

        <!-- Tags Selection -->
        <app-tags-selector
          [tagsConfig]="tagsConfig"
          [selectedTags]="state.selectedTags()"
          (tagToggled)="onTagToggle($event)"
        ></app-tags-selector>

        <!-- Icon Upload -->
        <app-icon-upload
          [iconPreview]="state.iconPreview()"
          (iconSelected)="onIconSelected($event)"
          (iconRemoved)="onIconRemoved()"
        ></app-icon-upload>
      </form>
    </div>
  `,
  styles: [`
    .step-content {
      padding: 1rem 0;
    }

    .full-width {
      width: 100%;
    }

    mat-form-field {
      margin-bottom: 0.5rem;
    }
  `]
})
export class AppPropertiesStepComponent implements OnInit, OnDestroy {
  readonly state = inject(CreateApplicationStateService);
  private cacheService = inject(CacheService);
  private configService = inject(VeConfigurationService);
  private destroy$ = new Subject<void>();

  // Tags config loaded directly (simplified, similar to framework names)
  tagsConfig: ITagsConfig | null = null;

  get appPropertiesForm() {
    return this.state.appPropertiesForm;
  }

  ngOnInit(): void {
    // Load tags config directly
    this.loadTagsConfig();
    // Load stacktypes
    this.state.loadStacktypes();
    // Set up async validator for application ID uniqueness
    const applicationIdControl = this.appPropertiesForm.get('applicationId');
    if (applicationIdControl && !applicationIdControl.asyncValidator) {
      applicationIdControl.setAsyncValidators([this.applicationIdUniqueValidator()]);
    }
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
  }

  /**
   * Custom async validator for application ID uniqueness
   */
  applicationIdUniqueValidator(): AsyncValidatorFn {
    return (control: AbstractControl): Observable<ValidationErrors | null> => {
      const applicationId = control.value;

      // In edit mode, skip validation for the current application ID
      if (this.state.editMode() && applicationId === this.state.editApplicationId()) {
        return of(null);
      }

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

  onApplicationIdInput(_event: Event): void {
    // Sync hostname with applicationId for oci-image and docker-compose frameworks
    this.state.syncHostnameWithApplicationId();
  }

  onIconSelected(event: IconSelectedEvent): void {
    this.state.selectedIconFile.set(event.file);
    this.state.iconContent.set(event.content);
    this.state.iconPreview.set(event.preview);
  }

  onIconRemoved(): void {
    this.state.selectedIconFile.set(null);
    this.state.iconContent.set(null);
    this.state.iconPreview.set(null);
  }

  onTagToggle(tagId: string): void {
    this.state.toggleTag(tagId);
  }

  onStacktypeChange(stacktype: string | null): void {
    this.state.selectedStacktype.set(stacktype);
  }

  /**
   * Load tags configuration directly (simplified, similar to framework names).
   * This avoids async signal issues in Playwright tests.
   */
  private loadTagsConfig(): void {
    this.configService.getTagsConfig().pipe(
      takeUntil(this.destroy$)
    ).subscribe({
      next: (config) => {
        this.tagsConfig = config;
      },
      error: (err) => {
        console.error('Failed to load tags config', err);
      }
    });
  }
}
