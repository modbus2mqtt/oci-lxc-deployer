import { Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';

export interface AddonNoticeDialogData {
  addonName: string;
  notice: string;
}

@Component({
  selector: 'app-addon-notice-dialog',
  standalone: true,
  imports: [MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>{{ data.addonName }}</h2>
    <mat-dialog-content>
      <div class="notice-content" [innerHTML]="renderedNotice"></div>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="onCancel()">Cancel</button>
      <button mat-flat-button color="primary" (click)="onConfirm()">OK</button>
    </mat-dialog-actions>
  `,
  styles: [`
    .notice-content {
      font-size: 0.95rem;
      line-height: 1.6;
    }
    .notice-content :first-child {
      margin-top: 0;
    }
    .notice-content code {
      background: #f5f5f5;
      padding: 0.1rem 0.3rem;
      border-radius: 3px;
      font-size: 0.9em;
    }
  `]
})
export class AddonNoticeDialogComponent {
  private dialogRef = inject(MatDialogRef<AddonNoticeDialogComponent>);
  data = inject<AddonNoticeDialogData>(MAT_DIALOG_DATA);
  private sanitizer = inject(DomSanitizer);

  renderedNotice: SafeHtml;

  constructor() {
    const html = marked.parse(this.data.notice) as string;
    this.renderedNotice = this.sanitizer.bypassSecurityTrustHtml(html);
  }

  onConfirm(): void {
    this.dialogRef.close(true);
  }

  onCancel(): void {
    this.dialogRef.close(false);
  }
}
