import { Component, inject, signal, OnInit } from '@angular/core';
import { MatDialogRef, MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog';
import { FormGroup, FormControl, Validators, ReactiveFormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { KeyValueTableComponent, KeyValuePair } from '../shared/components/key-value-table.component';
import { ITrack, ITrackEntry, ITracktypeEntry } from '../../shared/types';

export interface CreateTrackDialogData {
  tracktypes: ITracktypeEntry[];
  defaultTracktype?: string;
  suggestedEntries?: string[]; // Marker names to pre-fill
}

export interface CreateTrackDialogResult {
  track: ITrack;
}

@Component({
  selector: 'app-create-track-dialog',
  standalone: true,
  imports: [
    CommonModule,
    MatDialogModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatProgressSpinnerModule,
    KeyValueTableComponent
  ],
  template: `
    <h2 mat-dialog-title>Create Environment Track</h2>
    <mat-dialog-content>
      <form [formGroup]="trackForm">
        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Track Name</mat-label>
          <input matInput formControlName="name" required placeholder="e.g., production, staging" />
        </mat-form-field>

        <mat-form-field appearance="outline" class="full-width">
          <mat-label>Track Type</mat-label>
          <mat-select formControlName="tracktype" required>
            @for (tt of data.tracktypes; track tt.name) {
              <mat-option [value]="tt.name">{{ tt.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>

        <h4>Environment Variables</h4>
        @if (data.suggestedEntries && data.suggestedEntries.length > 0) {
          <p class="hint">Pre-filled from detected markers. Add values for each variable.</p>
        }
        <app-key-value-table
          [items]="trackEntries"
          keyPlaceholder="Variable Name"
          valuePlaceholder="Value"
          keyLabel="variable"
          (itemsChange)="onEntriesChange($event)"
        />
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button color="primary" (click)="save()" [disabled]="trackForm.invalid || loading()">
        @if (loading()) {
          <mat-spinner diameter="20"></mat-spinner>
        } @else {
          Create
        }
      </button>
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content {
      min-width: 400px;
      max-width: 600px;
    }

    .full-width {
      width: 100%;
    }

    h4 {
      margin: 1rem 0 0.5rem 0;
      font-weight: 500;
    }

    .hint {
      color: #666;
      font-size: 0.85rem;
      margin: 0 0 0.5rem 0;
    }

    mat-dialog-actions button {
      min-width: 80px;
    }

    mat-spinner {
      display: inline-block;
    }
  `]
})
export class CreateTrackDialog implements OnInit {
  dialogRef = inject(MatDialogRef<CreateTrackDialog, CreateTrackDialogResult>);
  data = inject<CreateTrackDialogData>(MAT_DIALOG_DATA);
  private configService = inject(VeConfigurationService);
  private errorHandler = inject(ErrorHandlerService);

  loading = signal(false);
  trackEntries = signal<KeyValuePair[]>([]);

  trackForm = new FormGroup({
    name: new FormControl('', Validators.required),
    tracktype: new FormControl('', Validators.required)
  });

  ngOnInit(): void {
    // Set default tracktype
    if (this.data.defaultTracktype) {
      this.trackForm.patchValue({ tracktype: this.data.defaultTracktype });
    } else if (this.data.tracktypes.length > 0) {
      this.trackForm.patchValue({ tracktype: this.data.tracktypes[0].name });
    }

    // Pre-fill entries from suggested markers
    if (this.data.suggestedEntries && this.data.suggestedEntries.length > 0) {
      this.trackEntries.set(this.data.suggestedEntries.map(name => ({
        key: name,
        value: ''
      })));
    }
  }

  onEntriesChange(entries: KeyValuePair[]): void {
    this.trackEntries.set(entries);
  }

  save(): void {
    if (this.trackForm.invalid) return;

    const formValue = this.trackForm.value;
    const entries: ITrackEntry[] = this.trackEntries().map(kv => ({
      name: kv.key,
      value: kv.value
    }));

    const track: Omit<ITrack, 'id'> = {
      name: formValue.name!,
      tracktype: formValue.tracktype!,
      entries
    };

    this.loading.set(true);
    this.configService.createTrack(track).subscribe({
      next: (res) => {
        // Construct the full track object to return
        const createdTrack: ITrack = {
          id: res.key,
          name: track.name,
          tracktype: track.tracktype,
          entries: track.entries
        };
        this.dialogRef.close({ track: createdTrack });
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to create track', err);
        this.loading.set(false);
      }
    });
  }
}
