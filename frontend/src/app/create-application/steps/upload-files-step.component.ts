import { Component, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';

import { CreateApplicationStateService } from '../services/create-application-state.service';
import { KeyValueTableComponent, KeyValuePair, BooleanColumnConfig } from '../../shared/components/key-value-table.component';
import { IUploadFile } from '../../../shared/types';

@Component({
  selector: 'app-upload-files-step',
  standalone: true,
  imports: [
    CommonModule,
    MatCardModule,
    MatIconModule,
    MatButtonModule,
    MatTooltipModule,
    KeyValueTableComponent
  ],
  template: `
    <div class="upload-files-step">
      <mat-card>
        <mat-card-header>
          <mat-card-title>
            <mat-icon>upload_file</mat-icon>
            Upload Files
          </mat-card-title>
        </mat-card-header>
        <mat-card-content>
          <p class="description">
            Configure files to be uploaded to the container.
            Use <code>config:</code> prefix for configuration files or <code>secure:</code> for sensitive files.
          </p>

          <app-key-value-table
            [items]="uploadFilesItems"
            [booleanColumns]="booleanColumns"
            keyPlaceholder="Filename (e.g., app.conf)"
            valuePlaceholder="Destination (e.g., config:app.conf)"
            keyLabel="file"
            (itemsChange)="onFilesChange($event)"
          ></app-key-value-table>

          <div class="examples">
            <p><strong>Examples:</strong></p>
            <ul>
              <li><code>mosquitto.conf</code> → <code>config:mosquitto.conf</code></li>
              <li><code>server.crt</code> → <code>config:certs/server.crt</code></li>
              <li><code>secrets.env</code> → <code>secure:secrets.env</code></li>
            </ul>
          </div>
        </mat-card-content>
      </mat-card>
    </div>
  `,
  styles: [`
    .upload-files-step {
      padding: 1rem 0;
    }

    mat-card-title {
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .description {
      margin-bottom: 1rem;
      color: rgba(0, 0, 0, 0.6);
    }

    .description code {
      background: rgba(0, 0, 0, 0.05);
      padding: 0.1rem 0.3rem;
      border-radius: 3px;
      font-family: monospace;
    }

    .examples {
      margin-top: 1.5rem;
      padding: 1rem;
      background: rgba(0, 0, 0, 0.02);
      border-radius: 4px;
    }

    .examples p {
      margin: 0 0 0.5rem 0;
    }

    .examples ul {
      margin: 0;
      padding-left: 1.5rem;
    }

    .examples li {
      margin: 0.25rem 0;
      font-family: monospace;
      font-size: 0.9rem;
    }

    .examples code {
      background: rgba(0, 0, 0, 0.05);
      padding: 0.1rem 0.3rem;
      border-radius: 3px;
    }
  `]
})
export class UploadFilesStepComponent {
  readonly state = inject(CreateApplicationStateService);

  uploadFilesItems = signal<KeyValuePair[]>([]);

  booleanColumns: BooleanColumnConfig[] = [
    { field: 'required', label: 'Req', icon: 'star', tooltip: 'Required file' },
    { field: 'advanced', label: 'Adv', icon: 'tune', tooltip: 'Advanced option (hidden by default)' }
  ];

  constructor() {
    // Initialize from state
    this.syncFromState();
  }

  private syncFromState(): void {
    const files = this.state.uploadFiles();
    const items: KeyValuePair[] = files.map(f => ({
      key: f.filename,
      value: f.destination,
      flags: {
        required: f.required ?? false,
        advanced: f.advanced ?? false
      }
    }));
    this.uploadFilesItems.set(items);
  }

  onFilesChange(items: KeyValuePair[]): void {
    this.uploadFilesItems.set(items);

    // Convert to IUploadFile[] and update state
    const uploadFiles: IUploadFile[] = items
      .filter(item => item.key && item.value)
      .map(item => ({
        filename: String(item.key),
        destination: String(item.value),
        required: item.flags?.['required'] ?? false,
        advanced: item.flags?.['advanced'] ?? false
      }));

    this.state.uploadFiles.set(uploadFiles);
  }
}
