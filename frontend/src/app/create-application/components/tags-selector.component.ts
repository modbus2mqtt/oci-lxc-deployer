import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatChipsModule } from '@angular/material/chips';

import { ITagsConfig } from '../../../shared/types';

@Component({
  selector: 'app-tags-selector',
  standalone: true,
  imports: [CommonModule, MatChipsModule],
  template: `
    @if (tagsConfig) {
      <div class="tags-selection-section">
        <div class="tags-selection-label">Tags (Optional)</div>
        <div class="tags-selection-container">
          @for (group of tagsConfig.groups; track group.id) {
            <div class="tag-group">
              <div class="tag-group-name">{{ group.name }}</div>
              <mat-chip-listbox multiple>
                @for (tag of group.tags; track tag.id) {
                  <mat-chip-option
                    [selected]="isTagSelected(tag.id)"
                    (selectionChange)="onTagToggle(tag.id)"
                  >
                    {{ tag.name }}
                  </mat-chip-option>
                }
              </mat-chip-listbox>
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .tags-selection-section {
      margin-top: 1rem;
    }

    .tags-selection-label {
      font-size: 0.875rem;
      color: rgba(0, 0, 0, 0.6);
      margin-bottom: 0.5rem;
    }

    .tags-selection-container {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }

    .tag-group {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .tag-group-name {
      font-weight: 500;
      font-size: 0.875rem;
      color: rgba(0, 0, 0, 0.87);
    }
  `]
})
export class TagsSelectorComponent {
  @Input() tagsConfig: ITagsConfig | null = null;
  @Input() selectedTags: string[] = [];

  @Output() tagToggled = new EventEmitter<string>();

  isTagSelected(tagId: string): boolean {
    return this.selectedTags.includes(tagId);
  }

  onTagToggle(tagId: string): void {
    this.tagToggled.emit(tagId);
  }
}
