import { Component, Inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { CommonModule } from '@angular/common';
import { IJsonError } from '../../shared/types';

@Component({
  selector: 'app-error-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule],
  template: `
    <div class="error-dialog-container">
      <button type="button" class="close-errors-btn" (click)="dialogRef.close()" aria-label="Close error list">&times;</button>
      <ul class="error-list-ul">
        <ng-container *ngFor="let err of data.errors">
          <li>
            {{ err.message }}
            <ul *ngIf="err.details && err.details.length">
              <ng-container *ngFor="let child of err.details">
                <li>{{ child.message }}</li>
              </ng-container>
            </ul>
          </li>
        </ng-container>
      </ul>
    </div>
  `,
  styles: [
    `.error-dialog-container{position:relative;padding:0}`,
    `.error-list-ul{background:#fff0f0;color:#c00;border:1.5px solid #e53935;border-radius:8px;padding:2em 2.5em;font-size:1.1em;min-width:420px;max-width:90vw;max-height:70vh;overflow:auto;box-shadow:0 4px 32px rgba(229,57,53,0.18)}`,
    `.error-list-ul ul{margin:0.25em 0 0 1.2em;padding:0}`,
    `.error-list-ul li{margin-bottom:0.25em;white-space:normal;word-break:break-word;overflow-wrap:anywhere}`,
    `.close-errors-btn{position:absolute;top:0.6em;right:0.8em;background:#fff0f0;border:1.5px solid #e53935;border-radius:50%;font-size:1.4em;color:#c00;cursor:pointer;width:2.2em;height:2.2em;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(229,57,53,0.10);transition:background 0.2s;opacity:0.8}`,
    `.close-errors-btn:hover{opacity:1;background:#ffe0e0;color:#a00;border-color:#c00}`,
    // Remove default Material dialog padding/background to avoid white bands
    `:host{display:block}`,
    `:host ::ng-deep .error-dialog-panel{margin:0;padding:0;background:transparent;box-shadow:none;border:none}`,
    `:host ::ng-deep .error-dialog-panel .mat-dialog-container{margin:0;padding:0;background:transparent;box-shadow:none;border:none}`,
    `:host ::ng-deep .error-dialog-panel .mat-dialog-content{padding:0;margin:0}`,
    `:host ::ng-deep .error-dialog-panel .cdk-overlay-pane{margin:0}`,
  ]
})
export class ErrorDialog {
  constructor(
    public dialogRef: MatDialogRef<ErrorDialog>,
    @Inject(MAT_DIALOG_DATA) public data: { errors: IJsonError[] }
  ) {}
}
