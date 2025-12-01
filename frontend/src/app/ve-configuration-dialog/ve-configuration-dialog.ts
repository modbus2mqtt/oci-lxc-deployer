
// ...existing code...
import { Component, OnInit, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { CommonModule } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators, FormControl } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { IApplicationWeb, IParameter } from '../../shared/types.mjs';
import { ProxmoxConfigurationService } from '../ve-configuration.service';

@Component({
  selector: 'app-ve-configuration-dialog',
  standalone: true,
  imports: [
    CommonModule, MatDialogModule, FormsModule, ReactiveFormsModule,
    MatFormFieldModule, MatInputModule, MatSelectModule, MatTooltipModule, MatSlideToggleModule
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
  private configService: ProxmoxConfigurationService = inject(ProxmoxConfigurationService);
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
      error: () => {
        this.error.set('Failed to load parameters');
        this.loading.set(false);
        this.dialogRef.close();
      }
    });
  }

  getTooltip(param: IParameter): string | undefined {
    return param.description;
  }

  save() {
    if (this.form.invalid) return;
    this.loading.set(true);
    const params = Object.entries(this.form.value)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([name, value]) => ({ name, value: value as string | number | boolean }));
    const application = this.data.app.id;
    const task = 'installation';
    this.configService.postProxmoxConfiguration(application, task, params).subscribe({
      next: () => {
        this.loading.set(false);
        this.dialogRef.close(this.form.value);
        // Navigate to process monitor after successful installation
        this.configService['router'].navigate(['/monitor']);
      },
      error: () => {
        this.error.set('Failed to install configuration');
        this.loading.set(false);
      }
    });
  }

  close(): void {
    this.dialogRef.close();
  }

  get groupNames(): string[] {
    return Object.keys(this.groupedParameters);
  }
}
