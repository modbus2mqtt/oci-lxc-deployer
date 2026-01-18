
// ...existing code...
import { Component, OnInit, inject, signal, Input } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';

import { ReactiveFormsModule, FormBuilder, FormGroup, Validators, FormControl } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { IApplicationWeb, IParameter, IParameterValue } from '../../shared/types';
import { VeConfigurationService, VeConfigurationParam } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { ParameterGroupComponent } from './parameter-group.component';
import type { NavigationExtras } from '@angular/router';
@Component({
  selector: 'app-ve-configuration-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    ReactiveFormsModule,
    MatButtonModule,
    ParameterGroupComponent
],
  templateUrl: './ve-configuration-dialog.html',
  styleUrl: './ve-configuration-dialog.scss',
})
export class VeConfigurationDialog implements OnInit {
  form: FormGroup;
  unresolvedParameters: IParameter[] = [];
  groupedParameters: Record<string, IParameter[]> = {};
  loading = signal(true);
  hasError = signal(false);
  showAdvanced = signal(false);
  private initialValues = new Map<string, IParameterValue>();
  private configService: VeConfigurationService = inject(VeConfigurationService);
  public dialogRef: MatDialogRef<VeConfigurationDialog> = inject(MatDialogRef<VeConfigurationDialog>);
  private errorHandler: ErrorHandlerService = inject(ErrorHandlerService);
  private fb: FormBuilder = inject(FormBuilder);
  public data = inject(MAT_DIALOG_DATA) as { app: IApplicationWeb; task?: string };
  private task = this.data.task ?? (globalThis.crypto?.randomUUID?.() ?? String(Date.now()));
  constructor(  ) {
    this.form = this.fb.group({});
  }
  ngOnInit(): void {
    // For demo purposes: use 'installation' as the default task, can be extended
    this.configService.getUnresolvedParameters(this.data.app.id, this.task).subscribe({
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
          // Store initial value for comparison
          this.initialValues.set(param.id, defaultValue);
        }
        // Sort parameters in each group: required first, then optional
        for (const group in this.groupedParameters) {
          this.groupedParameters[group] = this.groupedParameters[group].slice().sort((a, b) => Number(!!b.required) - Number(!!a.required));
        }
        this.form.markAllAsTouched();
        this.loading.set(false);
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to load parameters', err);
        this.loading.set(false);
        this.hasError.set(true);
        // Note: Dialog remains open so user can see the error and close manually
      }
    });
  }

  @Input() customActions?: boolean;

  save() {
    if (this.form.invalid) return;
    this.loading.set(true);
    
    // Separate params and changed parameters
    const params: VeConfigurationParam[] = [];
    const changedParams: VeConfigurationParam[] = [];
    
    for (const [paramId, currentValue] of Object.entries(this.form.value) as [string, IParameterValue][]) {
      const initialValue = this.initialValues.get(paramId);
      // Check if value has changed (compare with initial value)
      const hasChanged = initialValue !== currentValue && 
                        (currentValue !== null && currentValue !== undefined && currentValue !== '');
      
      if (hasChanged) {
        // Collect changed parameters for vmInstallContext
        if (currentValue !== null && currentValue !== undefined && currentValue !== '') {
          changedParams.push({ name: paramId, value: currentValue as IParameterValue });
          params.push({ name: paramId, value: currentValue as IParameterValue });
        }
      } else if (currentValue !== null && currentValue !== undefined && currentValue !== '') {
        // Include unchanged values that are not empty (for required fields)
        params.push({ name: paramId, value: currentValue as IParameterValue });
      }
    }
    
    const application = this.data.app.id;
    const task = 'installation';
    
    // Pass changedParams to backend for vmInstallContext
        this.configService.postVeConfiguration(application, task, params, changedParams.length > 0 ? changedParams : undefined).subscribe({
          next: (res) => {
            this.loading.set(false);
            // Navigate to process monitor; pass restartKey, vmInstallKey and original parameters
            const extras: NavigationExtras = {
              queryParams: res.restartKey ? { restartKey: res.restartKey } : {},
              state: { 
                originalParams: params,
                application: application,
                task: task,
                restartKey: res.restartKey,
                vmInstallKey: res.vmInstallKey
              }
            };
            this.dialogRef.close(this.form.value);
            this.configService['router'].navigate(['/monitor'], extras);
          },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to install configuration', err);
        this.loading.set(false);
      }
    });
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

  get missingRequiredParams(): IParameter[] {
    return this.unresolvedParameters.filter((p) =>
      p.required === true && (p.default === undefined || p.default === null || p.default === ''),
    );
  }

  get showMissingRequiredHint(): boolean {
    return this.missingRequiredParams.length > 0;
  }

  get taskKey(): string {
    return this.task;
  }


  get groupNames(): string[] {
    return Object.keys(this.groupedParameters);
  }

}
