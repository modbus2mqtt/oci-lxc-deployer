
// ...existing code...
import { Component, OnInit, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';

import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators, FormControl } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { IApplicationWeb, IParameter, IParameterValue } from '../../shared/types';
import { VeConfigurationService } from '../ve-configuration.service';
import type { NavigationExtras } from '@angular/router';
@Component({
  selector: 'app-ve-configuration-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    FormsModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    MatSlideToggleModule,
    MatIconModule,
    MatButtonModule
],
  templateUrl: './ve-configuration-dialog.html',
  styleUrl: './ve-configuration-dialog.scss',
})
export class VeConfigurationDialog implements OnInit {
  form: FormGroup;
  unresolvedParameters: IParameter[] = [];
  groupedParameters: Record<string, IParameter[]> = {};
  loading = signal(true);
  error = signal<string | null>(null);
  showAdvanced = signal(false);
  private configService: VeConfigurationService = inject(VeConfigurationService);
  public dialogRef: MatDialogRef<VeConfigurationDialog> = inject(MatDialogRef<VeConfigurationDialog>);
  private fb: FormBuilder = inject(FormBuilder);
  public data = inject(MAT_DIALOG_DATA) as { app: IApplicationWeb };
  constructor(  ) {
    this.form = this.fb.group({});
  }
  getGroupNames(): string[] {
    return Object.keys(this.groupedParameters);
  }
  ngOnInit(): void {
    // For demo purposes: use 'installation' as the default task, can be extended
    this.configService.getUnresolvedParameters(this.data.app.id, 'installation').subscribe({
      next: (res) => {
        this.unresolvedParameters = res.unresolvedParameters;
        // Group parameters by template
        this.groupedParameters = {};
        for (const param of this.unresolvedParameters) {
          const group = param.templatename || 'General';
          if (!this.groupedParameters[group]) this.groupedParameters[group] = [];
          this.groupedParameters[group].push(param);
          const validators = param.required ? [Validators.required] : [];
          const defaultValue = param.default !== undefined ? param.default : '';
          this.form.addControl(param.id, new FormControl(defaultValue, validators));
        }
        // Sort parameters in each group: required first, then optional
        for (const group in this.groupedParameters) {
          this.groupedParameters[group] = this.groupedParameters[group].slice().sort((a, b) => Number(!!b.required) - Number(!!a.required));
        }
        this.form.markAllAsTouched();
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.error.set(this.formatError('Failed to load parameters', err));
        this.loading.set(false);
      }
    });
  }

  getTooltip(param: IParameter): string | undefined {
    return param.description;
  }

  async onFileSelected(event: Event, paramId: string): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      try {
        const base64 = await this.readFileAsBase64(file);
        this.form.get(paramId)?.setValue(base64);
        this.form.get(paramId)?.markAsTouched();
      } catch (error) {
        this.error.set(`Failed to read file: ${error}`);
      }
    }
  }

  private readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:application/pdf;base64,")
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  save() {
    if (this.form.invalid) return;
    this.loading.set(true);
    const params = (Object.entries(this.form.value) as [string, IParameterValue][])
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([name, value]) => ({ name, value: value as IParameterValue }));
    const application = this.data.app.id;
    const task = 'installation';
    
    this.configService.postVeConfiguration(application, task, params).subscribe({
      next: (res) => {
        this.loading.set(false);
        // Navigate to process monitor; pass restartKey if present
        const extras: NavigationExtras = res.restartKey ? { queryParams: { restartKey: res.restartKey } } : {};
        this.configService['router'].navigate(['/monitor'], extras);
      },
      error: (err: unknown) => {
        this.error.set(this.formatError('Failed to install configuration', err));
        this.loading.set(false);
      }
    });
    this.dialogRef.close(this.form.value);
    this.configService['router'].navigate(['/monitor']);
  }

  close(): void {
    this.dialogRef.close();
  }

  toggleAdvanced(): void {
    this.showAdvanced.set(!this.showAdvanced());
  }

  hasAdvancedParams(): boolean {
    return this.unresolvedParameters.some(p => p.advanced);
  }

  isVisible(param: IParameter): boolean {
    if (param.advanced && !this.showAdvanced()) return false;
    if (param.if && !this.form.get(param.if)?.value) return false;
    return true;
  }

  isGroupVisible(groupName: string): boolean {
    const params = this.groupedParameters[groupName];
    return params?.some(p => this.isVisible(p)) ?? false;
  }

  get groupNames(): string[] {
    return Object.keys(this.groupedParameters);
  }

  private formatError(prefix: string, err: unknown): string {
    if (!err) return prefix;
    try {
      const errObj = err as Record<string, unknown>;
      const errorBody = errObj['error'] as Record<string, unknown> | undefined;
      const innerError = errorBody?.['error'] as Record<string, unknown> | undefined;
      
      if (innerError) {
        const name = innerError['name'] || 'Error';
        const message = innerError['message'] || '';
        const details = innerError['details'] as Record<string, unknown>[] | undefined;
        
        let result = `${prefix}\n\n${name}: ${message}`;
        if (details && Array.isArray(details)) {
          result += '\n\nDetails:\n' + details.map(d => `• ${d['message']}`).join('\n');
        }
        return result;
      }
      if (errorBody && typeof errorBody === 'object') {
        return `${prefix}:\n${JSON.stringify(errorBody, null, 2)}`;
      }
      if (errObj['message']) {
        return `${prefix}: ${errObj['message']}`;
      }
      return `${prefix}:\n${JSON.stringify(err, null, 2)}`;
    } catch {
      return `${prefix}: ${String(err)}`;
    }
  }
}
