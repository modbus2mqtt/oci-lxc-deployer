import { Component, OnInit, inject, signal } from '@angular/core';
import { FormGroup, FormControl, Validators, ReactiveFormsModule, FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { ITrack, ITrackEntry, ITracktypeEntry } from '../../shared/types';
import { KeyValueTableComponent, KeyValuePair } from '../shared/components/key-value-table.component';

@Component({
  selector: 'app-tracks-page',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatExpansionModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    KeyValueTableComponent
  ],
  templateUrl: './tracks-page.html',
  styleUrl: './tracks-page.scss'
})
export class TracksPage implements OnInit {
  private configService = inject(VeConfigurationService);
  private errorHandler = inject(ErrorHandlerService);

  loading = signal(false);
  tracktypes = signal<ITracktypeEntry[]>([]);
  tracks = signal<ITrack[]>([]);
  selectedTracktype = signal<string>('');

  // For creating/editing a track
  editingTrack = signal<ITrack | null>(null);
  isCreating = signal(false);

  // Form for new/edit track
  trackForm = new FormGroup({
    name: new FormControl('', Validators.required),
    tracktype: new FormControl('', Validators.required)
  });

  // Track entries as signal for KeyValueTableComponent
  trackEntries = signal<KeyValuePair[]>([]);

  ngOnInit(): void {
    this.loadTracktypes();
  }

  loadTracktypes(): void {
    this.loading.set(true);
    this.configService.getTracktypes().subscribe({
      next: (res) => {
        this.tracktypes.set(res.tracktypes);
        // Auto-select first tracktype
        if (res.tracktypes.length > 0) {
          this.selectedTracktype.set(res.tracktypes[0].name);
          this.loadTracks();
        } else {
          this.loading.set(false);
        }
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to load track types', err);
        this.loading.set(false);
      }
    });
  }

  loadTracks(): void {
    const tracktype = this.selectedTracktype();
    if (!tracktype) {
      this.loading.set(false);
      return;
    }

    this.loading.set(true);
    this.configService.getTracks(tracktype).subscribe({
      next: (res) => {
        this.tracks.set(res.tracks);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to load tracks', err);
        this.loading.set(false);
      }
    });
  }

  onTracktypeChange(tracktype: string): void {
    this.selectedTracktype.set(tracktype);
    this.cancelEdit();
    this.loadTracks();
  }

  startCreate(): void {
    this.isCreating.set(true);
    this.editingTrack.set(null);
    this.trackForm.reset();
    this.trackForm.patchValue({ tracktype: this.selectedTracktype() });
    this.trackEntries.set([]);
  }

  startEdit(track: ITrack): void {
    this.isCreating.set(false);
    this.editingTrack.set(track);
    this.trackForm.patchValue({
      name: track.name,
      tracktype: track.tracktype
    });
    // Convert ITrackEntry[] to KeyValuePair[]
    this.trackEntries.set(track.entries.map(e => ({
      key: e.name,
      value: String(e.value)
    })));
  }

  cancelEdit(): void {
    this.isCreating.set(false);
    this.editingTrack.set(null);
    this.trackForm.reset();
    this.trackEntries.set([]);
  }

  saveTrack(): void {
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

    if (this.editingTrack()) {
      // Update existing track
      this.configService.updateTrack({ ...track, id: this.editingTrack()!.id }).subscribe({
        next: () => {
          this.cancelEdit();
          this.loadTracks();
        },
        error: (err) => {
          this.errorHandler.handleError('Failed to update track', err);
          this.loading.set(false);
        }
      });
    } else {
      // Create new track
      this.configService.createTrack(track).subscribe({
        next: () => {
          this.cancelEdit();
          this.loadTracks();
        },
        error: (err) => {
          this.errorHandler.handleError('Failed to create track', err);
          this.loading.set(false);
        }
      });
    }
  }

  deleteTrack(track: ITrack, event: Event): void {
    event.stopPropagation();
    if (!confirm(`Delete track "${track.name}"?`)) return;

    this.loading.set(true);
    this.configService.deleteTrack(track.name).subscribe({
      next: () => {
        this.loadTracks();
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to delete track', err);
        this.loading.set(false);
      }
    });
  }

  onEntriesChange(entries: KeyValuePair[]): void {
    this.trackEntries.set(entries);
  }

  isEditing(): boolean {
    return this.isCreating() || this.editingTrack() !== null;
  }
}
