import { Component, inject, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatChipsModule } from '@angular/material/chips';

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
    MatChipsModule,
    KeyValueTableComponent
  ],
  template: `
    <div class="upload-files-step" data-testid="upload-files-step">
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
            Use a volume prefix followed by the file path.
          </p>

          @if (volumePrefixes().length > 0) {
            <div class="available-volumes">
              <span class="label">Available volumes:</span>
              <mat-chip-set>
                @for (prefix of volumePrefixes(); track prefix) {
                  <mat-chip>{{ prefix }}:</mat-chip>
                }
              </mat-chip-set>
            </div>
          }

          <app-key-value-table
            [items]="uploadFilesItems"
            [booleanColumns]="booleanColumns"
            keyPlaceholder="Destination (e.g., config:mosquitto.conf)"
            valuePlaceholder="Label (optional)"
            keyLabel="file"
            (itemsChange)="onFilesChange($event)"
          ></app-key-value-table>

          <div class="examples">
            <p><strong>Examples:</strong></p>
            <ul>
              <li><code>config:mosquitto.conf</code> - config file in root of config volume</li>
              <li><code>config:certs/server.crt</code> - config file in subdirectory</li>
              <li><code>data:init.sql</code> - data file for initialization</li>
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

    .available-volumes {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 1rem;
      flex-wrap: wrap;
    }

    .available-volumes .label {
      color: rgba(0, 0, 0, 0.6);
      font-size: 0.875rem;
    }

    .available-volumes mat-chip {
      font-family: monospace;
      font-size: 0.8rem;
    }
  `]
})
export class UploadFilesStepComponent {
  readonly state = inject(CreateApplicationStateService);

  uploadFilesItems: KeyValuePair[] = [];

  booleanColumns: BooleanColumnConfig[] = [
    { field: 'required', label: 'Req', icon: 'star', tooltip: 'Required file' },
    { field: 'advanced', label: 'Adv', icon: 'tune', tooltip: 'Advanced option (hidden by default)' }
  ];

  /** Extract volume prefixes from the volumes field (format: "name=/path\nname2=/path2") */
  volumePrefixes = computed(() => {
    const volumesValue = this.state.parameterForm.get('volumes')?.value;
    if (!volumesValue || typeof volumesValue !== 'string') {
      return [];
    }
    return volumesValue
      .split('\n')
      .map(line => line.split('=')[0]?.trim())
      .filter((prefix): prefix is string => !!prefix);
  });

  constructor() {
    // Initialize from state
    this.syncFromState();
  }

  private syncFromState(): void {
    const files = this.state.getUploadFiles();
    this.uploadFilesItems = files.map(f => ({
      key: f.destination,
      value: f.label ?? '',  // Label is optional
      flags: {
        required: f.required ?? false,
        advanced: f.advanced ?? false
      }
    }));
  }

  onFilesChange(items: KeyValuePair[]): void {
    this.uploadFilesItems = items;

    // Convert to IUploadFile[] and update state
    const uploadFiles: IUploadFile[] = items
      .filter(item => item.key)  // Only destination is required
      .map(item => {
        const destination = String(item.key);
        const label = String(item.value || '').trim();
        const result: IUploadFile = {
          destination,
          required: item.flags?.['required'] ?? false,
          advanced: item.flags?.['advanced'] ?? false
        };
        // Only set label if provided (non-empty)
        if (label) {
          result.label = label;
        }
        return result;
      });

    this.state.setUploadFiles(uploadFiles);
  }
}
