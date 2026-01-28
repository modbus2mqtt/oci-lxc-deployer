import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, signal } from '@angular/core';
import { FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ComposeService } from '../../services/docker-compose.service';

export type ComposeEnvSelectorMode = 'multi' | 'single';

@Component({
  selector: 'app-compose-env-selector',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatTooltipModule,
    MatSelectModule
  ],
  template: `
    <div class="compose-env-selector" [formGroup]="parameterForm">
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Docker Compose File</mat-label>
        <input type="file" #composeFileInput [id]="'compose-file-input'" (change)="onComposeFileSelected($event)" style="display: none;" accept=".yml,.yaml" />

        <!-- show only filename to user -->
        <input matInput [value]="composeFileName() || ''" [required]="true" readonly />

        <!-- keep actual payload in form control for backend -->
        <input type="hidden" formControlName="compose_file" />

        <button mat-icon-button matSuffix type="button" (click)="composeFileInput.click()" matTooltip="Select docker-compose.yml file" matTooltipPosition="above">
          <mat-icon>attach_file</mat-icon>
        </button>

        <!-- prevent duplicate "start" hints -->
        <mat-hint align="end">Upload your docker-compose.yml file</mat-hint>

        @if (composeFileError()) {
          <mat-error>{{ composeFileError() }}</mat-error>
        }
      </mat-form-field>

      @if (mode === 'single' && services().length > 1) {
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Select Service</mat-label>
          <mat-select [value]="selectedServiceName()" (selectionChange)="onServiceSelected($event.value)">
            @for (service of services(); track service.name) {
              <mat-option [value]="service.name">{{ service.name }}</mat-option>
            }
          </mat-select>
          <mat-hint>Select the service to configure volumes and environment variables for</mat-hint>
        </mat-form-field>
      }

      <mat-form-field appearance="outline" class="full-width" [class.error-field]="envFileError() || hasMissingEnvVars()">
        <mat-label>Environment File (.env)</mat-label>
        <input type="file" #envFileInput [id]="'env-file-input'" (change)="onEnvFileSelected($event)" style="display: none;" />

        <!-- show only filename to user -->
        <input matInput [value]="envFileName() || ''" [required]="requiredEnvVars().length > 0 && !hasEnvFile()" readonly />

        <!-- keep actual payload in form control for backend/validation -->
        <input type="hidden" formControlName="env_file" />

        <button mat-icon-button matSuffix type="button" (click)="envFileInput.click()" [matTooltip]="getEnvFileTooltip()" matTooltipPosition="above">
          <mat-icon>attach_file</mat-icon>
        </button>

        <mat-hint>
          @if (requiredEnvVars().length > 0 && !hasEnvFile()) {
            <span class="error-text">Required: Contains environment variables from docker-compose.yml</span>
          } @else if (hasEnvFile() && !hasMissingEnvVars()) {
            <span>.env uploaded (all required variables present)</span>
          } @else if (hasEnvFile() && hasMissingEnvVars()) {
            <span class="error-text">.env uploaded, but incomplete (missing variables)</span>
          } @else {
            <span>Optional: Upload your .env file</span>
          }
        </mat-hint>

        @if (envFileError()) {
          <mat-error>{{ envFileError() }}</mat-error>
        }
        @if (hasMissingEnvVars() && !envFileError()) {
          <mat-error>Some environment variables are missing. Please configure them in the next step.</mat-error>
        }
      </mat-form-field>

      @if (composeProperties()) {
        <mat-card [class]="'compose-properties-card ' + (hasMissingEnvVars() ? 'error-card' : '')">
          <mat-card-header>
            <mat-card-title>
              @if (hasMissingEnvVars()) {
                <mat-icon class="error-icon">error</mat-icon>
                Extracted Compose Properties (Errors)
              } @else {
                Extracted Compose Properties
              }
            </mat-card-title>
          </mat-card-header>
          <mat-card-content>
            @if (composeProperties()?.services) {
              <div class="compose-property">
                <strong>Services:</strong> {{ composeProperties()?.services }}
              </div>
            }
            @if (composeProperties()?.ports) {
              <div class="compose-property">
                <strong>Port Mappings:</strong>
                <pre>{{ composeProperties()?.ports }}</pre>
              </div>
            }
            @if (composeProperties()?.images) {
              <div class="compose-property">
                <strong>Images:</strong>
                <pre>{{ composeProperties()?.images }}</pre>
              </div>
            }
            @if (composeProperties()?.networks) {
              <div class="compose-property">
                <strong>Networks:</strong> {{ composeProperties()?.networks }}
              </div>
            }
            @if (composeProperties()?.volumes) {
              <div class="compose-property">
                <strong>Volumes:</strong>
                <pre>{{ composeProperties()?.volumes }}</pre>
              </div>
            }
            @if (requiredEnvVars().length > 0) {
              <div class="compose-property">
                <strong>Environment Variables:</strong>
                <div class="env-vars-list">
                  @for (varName of requiredEnvVars(); track varName) {
                    <div class="env-var-item" [class.missing]="missingEnvVars().includes(varName)">
                      <span class="env-var-name">{{ varName }}</span>
                      @if (missingEnvVars().includes(varName)) {
                        <span class="env-var-status error">Missing</span>
                      } @else {
                        <span class="env-var-status success">✓ Set</span>
                      }
                    </div>
                  }
                </div>
              </div>
            }
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: [
    `
      .compose-env-selector {
        width: 100%;
      }

      .full-width {
        width: 100%;
      }

      .compose-properties-card {
        width: 100%;
        margin-top: 1rem;
        background: #e8f5e9;
        border-left: 4px solid #4caf50;
      }

      .compose-properties-card mat-card-title {
        font-size: 0.95rem;
        font-weight: 600;
        color: #2e7d32;
      }

      .compose-property {
        margin-bottom: 0.75rem;
      }

      .compose-property:last-child {
        margin-bottom: 0;
      }

      .compose-property strong {
        display: block;
        margin-bottom: 0.25rem;
        color: #1b5e20;
        font-size: 0.875rem;
      }

      .compose-property pre {
        margin: 0.25rem 0 0 0;
        padding: 0.5rem;
        background: #fff;
        border: 1px solid #c8e6c9;
        border-radius: 4px;
        font-size: 0.8rem;
        white-space: pre-wrap;
        word-wrap: break-word;
        overflow-x: auto;
      }

      .error-field .mat-mdc-form-field-hint,
      .error-field .mat-mdc-form-field-error {
        color: #f44336;
      }

      .error-card {
        background: #ffebee !important;
        border-left-color: #f44336 !important;
      }

      .error-card mat-card-title {
        color: #c62828 !important;
      }

      .error-icon {
        color: #f44336;
        vertical-align: middle;
        margin-right: 0.5rem;
      }

      .env-vars-list {
        margin-top: 0.5rem;
      }

      .env-var-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.5rem;
        margin-bottom: 0.25rem;
        background: #fff;
        border-radius: 4px;
        border: 1px solid #e0e0e0;
      }

      .env-var-item.missing {
        border-color: #f44336;
        background: #ffebee;
      }

      .env-var-name {
        font-family: 'Courier New', monospace;
        font-weight: 600;
      }

      .env-var-status {
        font-size: 0.75rem;
        padding: 0.125rem 0.5rem;
        border-radius: 12px;
      }

      .env-var-status.error {
        background: #ffcdd2;
        color: #c62828;
      }

      .env-var-status.success {
        background: #c8e6c9;
        color: #2e7d32;
      }

      .error-text {
        color: #f44336;
      }
    `
  ]
})
export class ComposeEnvSelectorComponent {
  @Input() parameterForm!: FormGroup;
  @Input() mode: ComposeEnvSelectorMode = 'multi';

  // NEW: Parent gibt uns die parsed data (kein internes Parsing mehr)
  @Input() services = signal<ComposeService[]>([]);
  @Input() selectedServiceName = signal<string>('');
  @Input() requiredEnvVars = signal<string[]>([]);
  @Input() missingEnvVars = signal<string[]>([]);
  @Input() composeProperties = signal<{
    services?: string;
    ports?: string;
    images?: string;
    networks?: string;
    volumes?: string;
  } | null>(null);

  // Emittiere nur raw file changes, kein Parsing
  @Output() composeFileSelected = new EventEmitter<File>();
  @Output() envFileSelected = new EventEmitter<File>();
  @Output() serviceSelected = new EventEmitter<string>();

  composeFileName = signal<string>('');
  envFileName = signal<string>('');
  composeFileError = signal<string | null>(null);
  envFileError = signal<string | null>(null);
  hasEnvFile = signal<boolean>(false);

  async onComposeFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      this.composeFileName.set(file.name);
      this.composeFileSelected.emit(file);
    }
  }

  async onEnvFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      this.envFileName.set(file.name);
      this.hasEnvFile.set(true);
      this.envFileSelected.emit(file);
    } else {
      this.hasEnvFile.set(false);
      this.envFileName.set('');
    }
  }

  onServiceSelected(serviceName: string): void {
    this.serviceSelected.emit(serviceName);
  }

  getEnvFileTooltip(): string {
    return this.requiredEnvVars().length > 0
      ? `Required: .env file must contain all environment variables from docker-compose.yml`
      : 'Optional: Upload your .env file';
  }

  hasMissingEnvVars(): boolean {
    return this.missingEnvVars().length > 0;
  }
}
