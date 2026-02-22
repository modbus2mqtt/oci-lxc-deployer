import { Component, Input, Output, EventEmitter, signal, inject, OnDestroy } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from '../ve-configuration.service';
import { IPostFrameworkFromImageResponse } from '../../shared/types';
import { Subject } from 'rxjs';

@Component({
  selector: 'app-oci-image-step',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatTooltipModule,
    MatIconModule
  ],
  template: `
    <div class="oci-image-step">
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>OCI Image Reference</mat-label>
        <input 
          matInput 
          [value]="imageReference()" 
          (input)="onImageReferenceInput($event)"
          placeholder="e.g., mariadb:latest or ghcr.io/home-assistant/home-assistant:latest"
        />
        <mat-icon matSuffix [matTooltip]="getImageReferenceTooltip()">info</mat-icon>
        <mat-hint>
          @if (loadingImageAnnotations()) {
            <span>Checking image and fetching annotations...</span>
          } @else if (imageError()) {
            <span class="error-text">Error: {{ imageError() }}</span>
          } @else if (imageAnnotationsReceived()) {
            <span class="success-text">✓ Image found, annotations loaded</span>
          } @else {
            <span>Enter Docker Hub or GitHub Container Registry image reference</span>
          }
        </mat-hint>
        @if (imageError() && imageError()!.includes('not found')) {
          <mat-error>Image not found. Please check the image reference.</mat-error>
        }
      </mat-form-field>
      
      <div class="image-reference-help">
        <p><strong>Image Reference Format:</strong></p>
        <ul>
          <li><strong>Docker Hub:</strong> <code>image:tag</code> or <code>owner/image:tag</code> (e.g., <code>mariadb:latest</code>, <code>nodered/node-red:latest</code>)</li>
          <li><strong>GitHub Container Registry:</strong> <code>ghcr.io/owner/image:tag</code> (e.g., <code>ghcr.io/home-assistant/home-assistant:latest</code>)</li>
          <li><strong>Tag:</strong> Optional, defaults to <code>latest</code> if not specified</li>
        </ul>
        <p>The system will automatically fetch metadata (URL, documentation, source, vendor, description) from the image annotations and pre-fill the application properties in the next step.</p>
      </div>
    </div>
  `,
  styles: [`
    .oci-image-step {
      width: 100%;
    }
    
    .full-width {
      width: 100%;
    }
    
    .error-text {
      color: #f44336;
    }
    
    .success-text {
      color: #4caf50;
    }
    
    .image-reference-help {
      margin-top: 1rem;
      padding: 1rem;
      background: #f5f5f5;
      border-radius: 4px;
      font-size: 0.875rem;
    }
    
    .image-reference-help code {
      background: #fff;
      padding: 0.125rem 0.25rem;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
    }
    
    .image-reference-help ul {
      margin: 0.5rem 0;
      padding-left: 1.5rem;
    }
    
    .image-reference-help li {
      margin: 0.25rem 0;
    }
  `]
})
export class OciImageStepComponent implements OnDestroy {
  @Input() parameterForm!: FormGroup;
  @Input() imageReference = signal(''); // Jetzt als Input
  @Input() loadingImageAnnotations = signal(false); // Jetzt als Input
  @Input() imageError = signal<string | null>(null); // Jetzt als Input
  @Input() imageAnnotationsReceived = signal(false); // Jetzt als Input
  
  @Output() imageReferenceChange = new EventEmitter<string>();
  @Output() annotationsReceived = new EventEmitter<IPostFrameworkFromImageResponse>();
  
  private configService = inject(VeConfigurationService);
  private destroy$ = new Subject<void>();
  private imageInputSubject = new Subject<string>();
  private imageAnnotationsTimeout: ReturnType<typeof setTimeout> | null = null;
  
  constructor() {
    // REMOVE debounce logic - parent handles it
  }
  
  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.imageAnnotationsTimeout) {
      clearTimeout(this.imageAnnotationsTimeout);
    }
  }
  
  onImageReferenceInput(event: Event): void {
    const imageRef = (event.target as HTMLInputElement).value;
    this.imageReferenceChange.emit(imageRef); // Only emit to parent
  }
  
  getImageReferenceTooltip(): string {
    return `Enter an OCI image reference:
• Docker Hub: image:tag or owner/image:tag (e.g., mariadb:latest, nodered/node-red:latest)
• GitHub Container Registry: ghcr.io/owner/image:tag (e.g., ghcr.io/home-assistant/home-assistant:latest)
• Tag is optional and defaults to 'latest' if not specified
The system will automatically fetch metadata from the image and pre-fill application properties.`;
  }
  
  isValid(): boolean {
    return this.imageReference().trim().length > 0;
  }
}
