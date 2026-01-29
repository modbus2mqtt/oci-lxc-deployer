import { Component, Input, Output, EventEmitter, signal, inject, OnInit, OnChanges, OnDestroy, SimpleChanges } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { KeyValueTableComponent, KeyValuePair } from '../shared/components/key-value-table.component';
import { DockerComposeService, ParsedComposeData } from '../shared/services/docker-compose.service';
import { Subject, takeUntil, distinctUntilChanged } from 'rxjs';

@Component({
  selector: 'app-env-vars-step',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatCardModule,
    MatIconModule,
    KeyValueTableComponent
  ],
  template: `
    <div class="env-vars-step">
      <mat-card>
        <mat-card-header>
          <mat-card-title>
            Environment Variables
          </mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <p>Configure environment variables for your Docker Compose services. These will be written to the .env file.</p>
          
          <app-key-value-table
            [items]="envVarsItems"
            [keyPlaceholder]="'Variable Name'"
            [valuePlaceholder]="'Variable Value'"
            [keyLabel]="'environment variable'"
            valueType="text"
            (itemsChange)="onEnvVarsChange($event)"
          ></app-key-value-table>
          
          <div class="actions">
            <button mat-stroked-button color="primary" (click)="generateEnvFile()">
              <mat-icon>download</mat-icon>
              Generate .env File
            </button>
            <button mat-stroked-button color="primary" (click)="applyToForm()">
              <mat-icon>check</mat-icon>
              Apply to Form
            </button>
          </div>
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [`
    .env-vars-step {
      width: 100%;
    }
    
    .actions {
      margin-top: 1rem;
      display: flex;
      gap: 0.5rem;
    }
  `]
})
export class EnvVarsStepComponent implements OnInit, OnChanges, OnDestroy {
  @Input() parameterForm?: FormGroup;
  @Input() parsedComposeData!: ParsedComposeData | null;
  @Input() envVarScope: 'all' | 'service' = 'all';
  @Input() selectedServiceName = '';
  
  @Output() envVarsChanged = new EventEmitter<Map<string, string>>();
  
  private composeService = inject(DockerComposeService);
  private destroy$ = new Subject<void>();
  private envCtrlDestroy$ = new Subject<void>();
  private boundParameterForm?: FormGroup;

  envVarsItems = signal<KeyValuePair[]>([]);
  private lastEmittedSignature?: string;

  ngOnInit(): void {
    // Initial load (guarded)
    this.loadEnvVars();
    this.bindEnvFileChanges();
  }
  
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['parameterForm']) {
      this.bindEnvFileChanges();
      this.loadEnvVars();
      return;
    }

    // Reload when relevant inputs change (also handles parsedComposeData -> null, so table clears)
    if (changes['parsedComposeData'] || changes['envVarScope'] || changes['selectedServiceName']) {
      this.loadEnvVars();
    }
  }
  
  ngOnDestroy(): void {
    this.envCtrlDestroy$.next();
    this.envCtrlDestroy$.complete();

    this.destroy$.next();
    this.destroy$.complete();
  }

  private bindEnvFileChanges(): void {
    if (!this.parameterForm) {
      this.boundParameterForm = undefined;
      this.envCtrlDestroy$.next(); // stop previous subscription if any
      return;
    }

    // avoid redundant re-bind (ngOnChanges runs before ngOnInit)
    if (this.boundParameterForm === this.parameterForm) return;
    this.boundParameterForm = this.parameterForm;

    // stop previous env_file subscription (e.g. when parameterForm input is replaced)
    this.envCtrlDestroy$.next();

    const envCtrl = this.parameterForm.get('env_file');
    envCtrl?.valueChanges
      .pipe(
        distinctUntilChanged(),
        takeUntil(this.envCtrlDestroy$),
        takeUntil(this.destroy$)
      )
      .subscribe(() => this.loadEnvVars());
  }

  private pruneToRequiredVars(envVarsMap: Map<string, string>, requiredVars?: string[]): void {
    if (this.envVarScope !== 'service') return;

    const vars = requiredVars ?? (this.parsedComposeData ? this.getRequiredVars(this.parsedComposeData) : []);
    const requiredSet = new Set(vars);

    for (const k of Array.from(envVarsMap.keys())) {
      if (!requiredSet.has(k)) envVarsMap.delete(k);
    }
  }

  private loadEnvVars(): void {
    if (!this.parameterForm) {
      this.envVarsItems.set([]);
      this.emitEnvVarsChangedIfNeeded(new Map());
      return;
    }

    const envFileValue = this.parameterForm.get('env_file')?.value;
    const envVars = new Map<string, string>();

    // Load from .env file if available
    if (envFileValue) {
      try {
        const parsed = this.composeService.parseEnvFile(envFileValue);
        for (const [key, value] of parsed.entries()) {
          envVars.set(key, value);
        }
      } catch {
        // ignore malformed env content; keep table functional
      }
    }

    // If we don't have compose data yet, still show what's in the env file.
    if (!this.parsedComposeData) {
      const items: KeyValuePair[] = Array.from(envVars.entries()).map(([key, value]) => ({ key, value }));
      items.sort((a, b) => String(a.key).localeCompare(String(b.key)));
      this.envVarsItems.set(items);
      this.emitEnvVarsChangedIfNeeded(this.itemsToEnvVarsMap(items));
      return;
    }

    const requiredVars = this.getRequiredVars(this.parsedComposeData);

    // OCI compose mode: ignore vars for non-selected services
    this.pruneToRequiredVars(envVars, requiredVars);

    const filteredEnvVars = this.composeService.filterEnvVarsEqualToComposeDefaults(
      envVars,
      this.parsedComposeData,
      this.envVarScope,
      this.selectedServiceName
    );

    // Add required env vars (unless filtered)
    for (const varName of requiredVars) {
      if (!filteredEnvVars.has(varName)) {
        filteredEnvVars.set(varName, '');
      }
    }

    const items: KeyValuePair[] = Array.from(filteredEnvVars.entries()).map(([key, value]) => ({ key, value }));
    items.sort((a, b) => String(a.key).localeCompare(String(b.key)));

    this.envVarsItems.set(items);
    this.emitEnvVarsChangedIfNeeded(this.itemsToEnvVarsMap(items));
  }

  private getRequiredVars(data: ParsedComposeData): string[] {
    if (this.envVarScope === 'all') {
      return data.environmentVariablesRequired ?? data.environmentVariables ?? [];
    }

    const serviceName = this.selectedServiceName || data.services?.[0]?.name || '';
    if (!serviceName) return [];

    const cached = data.serviceEnvironmentVariablesRequired?.[serviceName] ?? data.serviceEnvironmentVariables?.[serviceName];
    if (cached) return cached;

    const service = data.services.find(s => s.name === serviceName);
    if (!service) return [];
    return this.composeService.extractServiceEnvironmentVariables(service.config);
  }

  private itemsToEnvVarsMap(items: KeyValuePair[]): Map<string, string> {
    const envVarsMap = new Map<string, string>();
    for (const item of items) {
      const key = String(item.key ?? '').trim();
      if (!key) continue;
      envVarsMap.set(key, String(item.value ?? ''));
    }
    return envVarsMap;
  }

  private mapSignature(map: Map<string, string>): string {
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v ?? ''}`)
      .join('\n');
  }

  private emitEnvVarsChangedIfNeeded(envVarsMap: Map<string, string>): void {
    const sig = this.mapSignature(envVarsMap);
    if (sig === this.lastEmittedSignature) return;
    this.lastEmittedSignature = sig;
    this.envVarsChanged.emit(envVarsMap);
  }

  onEnvVarsChange(items: KeyValuePair[]): void {
    this.envVarsItems.set(items);
    this.emitEnvVarsChangedIfNeeded(this.itemsToEnvVarsMap(items));
  }
  
  generateEnvFile(): void {
    const envVarsMap = this.itemsToEnvVarsMap(this.envVarsItems());
    this.pruneToRequiredVars(envVarsMap);

    const content = this.composeService.generateEnvFile(envVarsMap);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '.env';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  
  applyToForm(): void {
    if (!this.parameterForm) return;

    const envVarsMap = this.itemsToEnvVarsMap(this.envVarsItems());
    this.pruneToRequiredVars(envVarsMap);

    const content = this.composeService.generateEnvFile(envVarsMap);
    const valueWithMetadata = this.composeService.envFileToBase64WithMetadata(content, '.env');

    const envCtrl = this.parameterForm.get('env_file');
    envCtrl?.setValue(valueWithMetadata, { emitEvent: false });
    envCtrl?.markAsTouched();

    // keep UI consistent with what we just wrote
    this.loadEnvVars();

    // ensure parent is in sync even if loadEnvVars early-returns differently
    this.emitEnvVarsChangedIfNeeded(envVarsMap);
  }
}
