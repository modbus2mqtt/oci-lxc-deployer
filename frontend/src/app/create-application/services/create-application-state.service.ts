import { Injectable, signal, inject } from '@angular/core';
import { FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Subject } from 'rxjs';

import { IFrameworkName, IParameter, IPostFrameworkFromImageResponse, ITagsConfig } from '../../../shared/types';
import { ComposeService, ParsedComposeData } from '../../shared/services/docker-compose.service';

/**
 * State service for Create Application wizard.
 * Holds all shared state (signals, forms) across step components.
 */
@Injectable({ providedIn: 'root' })
export class CreateApplicationStateService {
  private fb = inject(FormBuilder);

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
}
