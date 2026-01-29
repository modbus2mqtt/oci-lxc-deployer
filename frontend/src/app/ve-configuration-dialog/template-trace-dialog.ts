import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { IParameterTraceEntry, ITemplateProcessorLoadResult, ITemplateTraceEntry } from '../../shared/types';

export interface TemplateTraceDialogData {
  applicationName: string;
  task: string;
  trace: ITemplateProcessorLoadResult;
  missingRequiredIds: string[];
}

@Component({
  selector: 'app-template-trace-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatDialogModule, MatButtonModule],
  templateUrl: './template-trace-dialog.html',
  styleUrl: './template-trace-dialog.scss',
})
export class TemplateTraceDialog {
  private dialogRef = inject(MatDialogRef<TemplateTraceDialog>);
  data = inject(MAT_DIALOG_DATA) as TemplateTraceDialogData;

  filterText = '';

  close(): void {
    this.dialogRef.close();
  }

  get templateTrace(): ITemplateTraceEntry[] {
    return this.data.trace.templateTrace ?? [];
  }

  get parameterTrace(): IParameterTraceEntry[] {
    return this.data.trace.parameterTrace ?? [];
  }

  get filterIds(): string[] {
    return this.filterText
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  get filteredParameters(): IParameterTraceEntry[] {
    const ids = this.filterIds;
    if (ids.length > 0) {
      return this.parameterTrace.filter((param) => ids.includes(param.id));
    }
    if (this.data.missingRequiredIds.length > 0) {
      return this.parameterTrace.filter((param) =>
        this.data.missingRequiredIds.includes(param.id),
      );
    }
    return this.parameterTrace;
  }

  sourceLabel(param: IParameterTraceEntry): string {
    if (param.source === 'user_input') return 'User input';
    if (param.source === 'default') return 'Default';
    if (param.source === 'missing') return 'Missing';
    if (param.source === 'template_properties') return 'Template properties';
    return 'Template output';
  }

  sourceTemplateLabel(param: IParameterTraceEntry): string {
    if (param.source === 'user_input' || param.source === 'default' || param.source === 'missing') {
      return '-';
    }
    return param.sourceTemplate ?? '-';
  }

  usedInLabel(param: IParameterTraceEntry): string {
    return param.templatename ?? param.template ?? '-';
  }
}
