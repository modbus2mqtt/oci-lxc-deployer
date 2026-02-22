import { Component, Input, Output, EventEmitter, signal, inject, OnInit } from '@angular/core';
import { FormGroup, ReactiveFormsModule, FormsModule, Validators } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatExpansionModule } from '@angular/material/expansion';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import { ComposeService, DockerComposeService, ParsedComposeData } from '../shared/services/docker-compose.service';
import { IComposeWarning } from '../../shared/types-frontend';

@Component({
  selector: 'app-docker-compose-step',
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
    MatSelectModule,
    MatExpansionModule
  ],
  template: `
    <div class="docker-compose-step" [formGroup]="parameterForm">
      <mat-form-field appearance="outline" class="full-width">
        <mat-label>Docker Compose File</mat-label>
        <input type="file" #composeFileInput id="compose-file-input" (change)="onComposeFileSelected($event)" style="display: none;" accept=".yml,.yaml" />
        <input matInput [formControlName]="'compose_file'" [required]="true" readonly />
        <button mat-icon-button matSuffix type="button" (click)="composeFileInput.click()" matTooltip="Select docker-compose.yml file" matTooltipPosition="above">
          <mat-icon>attach_file</mat-icon>
        </button>
        <mat-hint>Upload your docker-compose.yml file</mat-hint>
        @if (composeFileError()) {
          <mat-error>{{ composeFileError() }}</mat-error>
        }
      </mat-form-field>
      
      @if (services().length > 1) {
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
        <input type="file" #envFileInput id="env-file-input" (change)="onEnvFileSelected($event)" style="display: none;" />
        <input matInput [formControlName]="'env_file'" [required]="requiredEnvVars().length > 0 && !hasEnvFile()" readonly />
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

      @if (composeWarnings().length > 0) {
        <mat-card class="compose-warnings-card">
          <mat-card-header>
            <mat-card-title>
              <mat-icon class="warning-icon">info_outline</mat-icon>
              LXC Migration Notes ({{ composeWarnings().length }})
            </mat-card-title>
          </mat-card-header>
          <mat-card-content>
            <p class="warnings-intro">The following docker-compose features require manual configuration or work differently in LXC:</p>
            <mat-accordion>
              @for (warning of composeWarnings(); track warning.id) {
                <mat-expansion-panel>
                  <mat-expansion-panel-header>
                    <mat-panel-title>
                      <mat-icon [class]="'warning-severity-' + warning.severity">
                        {{ warning.severity === 'warning' ? 'warning' : 'info' }}
                      </mat-icon>
                      <span class="warning-feature">{{ warning.title }}</span>
                    </mat-panel-title>
                    @if (warning.affectedServices && warning.affectedServices.length > 0) {
                      <mat-panel-description>
                        Services: {{ warning.affectedServices.join(', ') }}
                      </mat-panel-description>
                    }
                  </mat-expansion-panel-header>
                  <div class="warning-content" [innerHTML]="renderMarkdown(warning.description)"></div>
                </mat-expansion-panel>
              }
            </mat-accordion>
          </mat-card-content>
        </mat-card>
      }
    </div>
  `,
  styles: [`
    .docker-compose-step {
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

    .compose-warnings-card {
      width: 100%;
      margin-top: 1rem;
      background: #fff8e1;
      border-left: 4px solid #ffa726;
    }

    .compose-warnings-card mat-card-title {
      font-size: 0.95rem;
      font-weight: 600;
      color: #e65100;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .warning-icon {
      color: #ffa726;
    }

    .warnings-intro {
      font-size: 0.875rem;
      color: #666;
      margin-bottom: 1rem;
    }

    .warning-severity-warning {
      color: #f57c00;
      margin-right: 0.5rem;
    }

    .warning-severity-info {
      color: #1976d2;
      margin-right: 0.5rem;
    }

    .warning-feature {
      font-weight: 500;
    }

    .warning-content {
      padding: 0.5rem 0;
      font-size: 0.875rem;
      line-height: 1.6;
    }

    .warning-content p {
      margin: 0.5rem 0;
    }

    .warning-content strong {
      color: #333;
    }

    .warning-content code {
      background: #f5f5f5;
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
      font-size: 0.8rem;
    }

    .warning-content pre {
      background: #263238;
      color: #aed581;
      padding: 0.75rem;
      border-radius: 4px;
      overflow-x: auto;
      font-size: 0.8rem;
      margin: 0.5rem 0;
    }

    .warning-content pre code {
      background: transparent;
      padding: 0;
      color: inherit;
    }

    .warning-content ul {
      margin: 0.5rem 0;
      padding-left: 1.5rem;
    }

    .warning-content li {
      margin: 0.25rem 0;
    }

    ::ng-deep .mat-expansion-panel {
      margin-bottom: 0.5rem !important;
    }

    ::ng-deep .mat-expansion-panel-header {
      padding: 0 16px !important;
    }

    ::ng-deep .mat-expansion-panel-header-title {
      display: flex;
      align-items: center;
    }
  `]
})
export class DockerComposeStepComponent implements OnInit {
  @Input() parameterForm!: FormGroup;
  @Output() envVarsRequired = new EventEmitter<boolean>();
  @Output() composeDataChanged = new EventEmitter<ParsedComposeData>();
  @Output() serviceSelected = new EventEmitter<string>();

  private composeService = inject(DockerComposeService);
  private sanitizer = inject(DomSanitizer);

  // Warnings for unsupported docker-compose features
  composeWarnings = signal<IComposeWarning[]>([]);
  
  ngOnInit(): void {
    // Check if compose_file is already set when component initializes
    const composeFileValue = this.parameterForm.get('compose_file')?.value;
    if (composeFileValue) {
      this.parseComposeFile(composeFileValue);
    }
    
    // Check if env_file is already set
    const envFileValue = this.parameterForm.get('env_file')?.value;
    this.hasEnvFile.set(!!envFileValue);
    if (envFileValue) {
      this.validateEnvFile(envFileValue);
    }
  }
  
  composeProperties = signal<{
    services?: string;
    ports?: string;
    images?: string;
    networks?: string;
    volumes?: string;
  } | null>(null);
  
  composeFileError = signal<string | null>(null);
  envFileError = signal<string | null>(null);
  
  // Services and selection
  services = signal<ComposeService[]>([]);
  selectedServiceName = signal<string>('');
  parsedComposeData: ParsedComposeData | null = null;
  
  // Environment variables (only for selected service)
  requiredEnvVars = signal<string[]>([]);
  missingEnvVars = signal<string[]>([]);
  envVarValues = signal<Record<string, string>>({});
  
  hasEnvFile = signal<boolean>(false);
  
  async onComposeFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      try {
        const base64 = await this.readFileAsBase64(file);
        // Store the base64 value with filename metadata: file:filename:content:base64content
        const valueWithMetadata = `file:${file.name}:content:${base64}`;
        this.parameterForm.get('compose_file')?.setValue(valueWithMetadata);
        this.parameterForm.get('compose_file')?.markAsTouched();
        this.composeFileError.set(null);
        
        // Parse compose file
        await this.parseComposeFile(valueWithMetadata);
        
        // Emit event to invalidate following steps
        if (this.parsedComposeData) {
          this.composeDataChanged.emit(this.parsedComposeData);
        }
      } catch (error) {
        this.composeFileError.set(`Failed to read file: ${error}`);
      }
    }
  }
  
  async onEnvFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      try {
        const base64 = await this.readFileAsBase64(file);
        // Store the base64 value with filename metadata: file:filename:content:base64content
        const valueWithMetadata = `file:${file.name}:content:${base64}`;
        this.parameterForm.get('env_file')?.setValue(valueWithMetadata);
        this.parameterForm.get('env_file')?.markAsTouched();
        this.envFileError.set(null);
        this.hasEnvFile.set(true);
        
        // Validate .env file against required variables
        await this.validateEnvFile(valueWithMetadata);
        
        // Emit event to invalidate following steps
        if (this.parsedComposeData) {
          this.composeDataChanged.emit(this.parsedComposeData);
        }
      } catch (error) {
        this.envFileError.set(`Failed to read file: ${error}`);
        this.hasEnvFile.set(false);
      }
    } else {
      this.hasEnvFile.set(false);
    }
  }
  
  onServiceSelected(serviceName: string): void {
    this.selectedServiceName.set(serviceName);
    this.serviceSelected.emit(serviceName);
    
    // Update required env vars for selected service
    this.updateRequiredEnvVarsForService(serviceName);
    
    // Update volumes for selected service
    this.updateVolumesForService(serviceName);
    
    // Re-validate env file
    const envFileValue = this.parameterForm.get('env_file')?.value;
    if (envFileValue) {
      this.validateEnvFile(envFileValue);
    }
  }
  
  private async parseComposeFile(base64OrValue: string): Promise<void> {
    this.parsedComposeData = this.composeService.parseComposeFile(base64OrValue);

    if (!this.parsedComposeData) {
      this.composeFileError.set('Failed to parse docker-compose.yml file');
      this.composeProperties.set(null);
      this.services.set([]);
      this.selectedServiceName.set('');
      this.requiredEnvVars.set([]);
      this.composeWarnings.set([]);
      return;
    }

    // Detect warnings for unsupported/partial features
    const warnings = this.composeService.detectComposeWarnings(this.parsedComposeData);
    this.composeWarnings.set(warnings);

    // Set services
    this.services.set(this.parsedComposeData.services);

    // Auto-select first service
    if (this.parsedComposeData.services.length > 0) {
      const firstService = this.parsedComposeData.services[0];
      this.selectedServiceName.set(firstService.name);

      // ✅ Wichtig: Parent informieren, damit Step "Environment Variables" gerendert wird
      this.serviceSelected.emit(firstService.name);

      // If only one service, auto-fill volumes
      if (this.parsedComposeData.services.length === 1) {
        this.updateVolumesForService(firstService.name);
      }

      // Update required env vars for selected service
      this.updateRequiredEnvVarsForService(firstService.name);
    }

    // Set properties
    this.composeProperties.set(this.parsedComposeData.properties);
    
    // Set volumes in parameterForm if it exists
    if (this.parsedComposeData.properties.volumes && this.parameterForm.get('volumes')) {
      this.parameterForm.get('volumes')?.setValue(this.parsedComposeData.properties.volumes);
    }
    
    // Make env_file required if environment variables are found
    const envFileControl = this.parameterForm.get('env_file');
    if (envFileControl && this.requiredEnvVars().length > 0) {
      envFileControl.setValidators([Validators.required]);
      envFileControl.updateValueAndValidity();
      this.envVarsRequired.emit(true);
    } else if (envFileControl) {
      envFileControl.clearValidators();
      envFileControl.updateValueAndValidity();
      this.envVarsRequired.emit(false);
    }
    
    // Check if .env file is already uploaded and validate it
    const envFileValue = this.parameterForm.get('env_file')?.value;
    if (envFileValue) {
      this.hasEnvFile.set(true);
      await this.validateEnvFile(envFileValue);
    } else {
      this.hasEnvFile.set(false);
      this.missingEnvVars.set([...this.requiredEnvVars()]);
    }
  }
  
  private updateRequiredEnvVarsForService(serviceName: string): void {
    if (!this.parsedComposeData) {
      return;
    }
    
    const service = this.parsedComposeData.services.find(s => s.name === serviceName);
    if (!service) {
      this.requiredEnvVars.set([]);
      return;
    }
    
    // Extract environment variables only for this service
    const envVars = this.composeService.extractServiceEnvironmentVariables(service.config);
    this.requiredEnvVars.set(envVars);
    
    // Update missing vars
    this.updateMissingEnvVars();
  }
  
  private updateVolumesForService(serviceName: string): void {
    if (!this.parsedComposeData) {
      return;
    }
    
    const service = this.parsedComposeData.services.find(s => s.name === serviceName);
    if (!service || !this.parsedComposeData.composeData) {
      return;
    }
    
    // Extract volumes only for this service
    const volumes = this.composeService.extractServiceVolumes(service.config, this.parsedComposeData.composeData);
    
    if (volumes.length > 0 && this.parameterForm.get('volumes')) {
      this.parameterForm.get('volumes')?.setValue(volumes.join('\n'));
    }
  }
  
  private async validateEnvFile(base64OrValue: string): Promise<void> {
    if (!this.parsedComposeData) {
      return;
    }
    
    try {
      const envVars = this.composeService.parseEnvFile(base64OrValue);
      
      // Check which required vars are missing
      const missing: string[] = [];
      for (const varName of this.requiredEnvVars()) {
        if (!envVars.has(varName) || !envVars.get(varName)) {
          missing.push(varName);
        }
      }
      
      this.missingEnvVars.set(missing);
      
      // Update envVarValues with values from .env file
      const currentValues = { ...this.envVarValues() };
      for (const [key, value] of envVars.entries()) {
        currentValues[key] = value;
      }
      this.envVarValues.set(currentValues);
      
      // Update form validation
      const envFileControl = this.parameterForm.get('env_file');
      if (missing.length > 0) {
        envFileControl?.setErrors({ missingVars: true });
      } else {
        envFileControl?.setErrors(null);
      }
    } catch (error) {
      this.envFileError.set(`Failed to parse .env file: ${error}`);
      this.missingEnvVars.set([...this.requiredEnvVars()]);
    }
  }
  
  private updateMissingEnvVars(): void {
    const missing: string[] = [];
    const currentValues = this.envVarValues();
    
    for (const varName of this.requiredEnvVars()) {
      if (!currentValues[varName] || String(currentValues[varName]).trim() === '') {
        missing.push(varName);
      }
    }
    
    this.missingEnvVars.set(missing);
    
    // Update form validation
    const envFileControl = this.parameterForm.get('env_file');
    if (missing.length > 0 && this.requiredEnvVars().length > 0) {
      envFileControl?.setErrors({ missingVars: true });
    } else {
      envFileControl?.setErrors(null);
    }
  }
  
  getEnvFileTooltip(): string {
    if (this.requiredEnvVars().length > 0) {
      return `Required: .env file must contain all environment variables from docker-compose.yml`;
    }
    return 'Optional: Upload your .env file';
  }
  
  hasMissingEnvVars(): boolean {
    return this.missingEnvVars().length > 0;
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
  
  isValid(): boolean {
    const composeFile = this.parameterForm.get('compose_file')?.value;
    return composeFile && composeFile.trim().length > 0;
  }
  
  getParsedComposeData(): ParsedComposeData | null {
    return this.parsedComposeData;
  }
  
  getSelectedServiceName(): string {
    return this.selectedServiceName();
  }

  renderMarkdown(markdown: string): SafeHtml {
    const html = marked.parse(markdown, { async: false }) as string;
    return this.sanitizer.bypassSecurityTrustHtml(html);
  }
}
