
// ...existing code...
import { Component, OnInit, inject, signal, Input } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';

import { ReactiveFormsModule, FormBuilder, FormGroup, Validators, FormControl } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { IApplicationWeb, IParameter, IParameterValue, IEnumValuesResponse } from '../../shared/types';
import { VeConfigurationService, VeConfigurationParam } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { ParameterGroupComponent } from './parameter-group.component';
import { TemplateTraceDialog } from './template-trace-dialog';
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
  private enumRefreshAttempted = false;
  private configService: VeConfigurationService = inject(VeConfigurationService);
  public dialogRef: MatDialogRef<VeConfigurationDialog> = inject(MatDialogRef<VeConfigurationDialog>);
  private errorHandler: ErrorHandlerService = inject(ErrorHandlerService);
  private fb: FormBuilder = inject(FormBuilder);
  private dialog = inject(MatDialog);
  public data = inject(MAT_DIALOG_DATA) as { app: IApplicationWeb; task?: string };
  private task = this.data.task ?? 'installation';
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
        this.loadEnumValues();
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to load parameters', err);
        this.loading.set(false);
        this.hasError.set(true);
        // Note: Dialog remains open so user can see the error and close manually
      }
    });
  }

  private loadEnumValues(): void {
    const enumParams = this.unresolvedParameters.filter((p) => p.type === 'enum');
    if (enumParams.length === 0) return;
    const allEnumsPresent = enumParams.every(
      (p) => Array.isArray(p.enumValues) && p.enumValues.length > 0,
    );
    if (allEnumsPresent) return;

    const params = enumParams
      .map((p) => ({
        id: p.id,
        value: this.form.get(p.id)?.value as IParameterValue,
      }))
      .filter((p) => p.value !== null && p.value !== undefined && p.value !== '');

    this.configService.postEnumValues(this.data.app.id, this.task, params).subscribe({
      next: (res: IEnumValuesResponse) => {
        for (const entry of res.enumValues) {
          const param = this.unresolvedParameters.find((p) => p.id === entry.id);
          if (!param) continue;
          param.enumValues = entry.enumValues;
          if (entry.default !== undefined) {
            param.default = entry.default;
            const control = this.form.get(entry.id);
            if (control && (control.value === '' || control.value === null || control.value === undefined)) {
              control.setValue(entry.default);
              this.initialValues.set(entry.id, entry.default as IParameterValue);
            }
          }
        }
        const missingEnums = this.unresolvedParameters.filter(
          (p) => p.type === 'enum' && (!p.enumValues || p.enumValues.length === 0),
        );
        if (missingEnums.length > 0 && !this.enumRefreshAttempted) {
          this.enumRefreshAttempted = true;
          this.configService.postEnumValues(this.data.app.id, this.task, params, true).subscribe({
            next: (retryRes: IEnumValuesResponse) => {
              for (const entry of retryRes.enumValues) {
                const param = this.unresolvedParameters.find((p) => p.id === entry.id);
                if (!param) continue;
                param.enumValues = entry.enumValues;
                if (entry.default !== undefined) {
                  param.default = entry.default;
                  const control = this.form.get(entry.id);
                  if (control && (control.value === '' || control.value === null || control.value === undefined)) {
                    control.setValue(entry.default);
                    this.initialValues.set(entry.id, entry.default as IParameterValue);
                  }
                }
              }
            },
            error: (err: unknown) => {
              this.errorHandler.handleError('Failed to refresh enum values', err);
            }
          });
        }
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to load enum values', err);
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
      
      // Extract base64 content if value has file metadata format: file:filename:content:base64content
      let processedValue: IParameterValue = currentValue;
      if (typeof currentValue === 'string' && currentValue.match(/^file:[^:]+:content:(.+)$/)) {
        const match = currentValue.match(/^file:[^:]+:content:(.+)$/);
        if (match) {
          processedValue = match[1]; // Extract only the base64 content
        }
      }
      
      // Check if value has changed (compare with initial value)
      const hasChanged = initialValue !== processedValue && 
                        (processedValue !== null && processedValue !== undefined && processedValue !== '');
      
      if (hasChanged) {
        // Collect changed parameters for vmInstallContext
        if (processedValue !== null && processedValue !== undefined && processedValue !== '') {
          changedParams.push({ name: paramId, value: processedValue });
          params.push({ name: paramId, value: processedValue });
        }
      } else if (processedValue !== null && processedValue !== undefined && processedValue !== '') {
        // Include unchanged values that are not empty (for required fields)
        params.push({ name: paramId, value: processedValue });
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

  get missingRequiredParamsLabel(): string {
    return this.missingRequiredParams.map((p) => p.id).join(', ');
  }

  get taskKey(): string {
    return this.task;
  }

  openTemplateTrace(): void {
    this.configService.getTemplateTrace(this.data.app.id, this.task).subscribe({
      next: (trace) => {
        this.dialog.open(TemplateTraceDialog, {
          width: '900px',
          data: {
            applicationName: this.data.app.name,
            task: this.task,
            trace,
            missingRequiredIds: this.missingRequiredParams.map((param) => param.id),
          },
        });
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to load template trace', err);
      }
    });
  }


  get groupNames(): string[] {
    return Object.keys(this.groupedParameters);
  }

}
