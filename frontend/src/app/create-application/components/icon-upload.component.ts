import { Component, Input, Output, EventEmitter, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';

export interface IconSelectedEvent {
  file: File;
  content: string;
  preview: string;
}

@Component({
  selector: 'app-icon-upload',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule],
  template: `
    <div class="icon-upload-section">
      <div class="icon-upload-label">Application Icon (Optional)</div>
      <div class="icon-upload-container">
        @if (iconPreview) {
          <div class="icon-preview">
            <img [src]="iconPreview" alt="Icon preview" />
            <button type="button" mat-icon-button (click)="onRemoveIcon()" class="remove-icon-btn">
              <mat-icon>close</mat-icon>
            </button>
          </div>
        }
        <input
          #fileInput
          type="file"
          accept="image/*"
          (change)="onFileSelected($event)"
          style="display: none;"
        />
        <button type="button" mat-stroked-button (click)="openFileDialog()">
          <mat-icon>upload</mat-icon>
          {{ iconPreview ? 'Change Icon' : 'Upload Icon' }}
        </button>
      </div>
    </div>
  `,
  styles: [`
    .icon-upload-section {
      margin-top: 1rem;
    }

    .icon-upload-label {
      font-size: 0.875rem;
      color: rgba(0, 0, 0, 0.6);
      margin-bottom: 0.5rem;
    }

    .icon-upload-container {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .icon-preview {
      position: relative;
      width: 64px;
      height: 64px;
    }

    .icon-preview img {
      width: 100%;
      height: 100%;
      object-fit: contain;
      border: 1px solid #e0e0e0;
      border-radius: 4px;
    }

    .remove-icon-btn {
      position: absolute;
      top: -8px;
      right: -8px;
      width: 24px;
      height: 24px;
      line-height: 24px;
      background: #f44336;
      color: white;
    }

    .remove-icon-btn mat-icon {
      font-size: 16px;
      width: 16px;
      height: 16px;
      line-height: 16px;
    }
  `]
})
export class IconUploadComponent {
  @Input() iconPreview: string | null = null;

  @Output() iconSelected = new EventEmitter<IconSelectedEvent>();
  @Output() iconRemoved = new EventEmitter<void>();

  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  openFileDialog(): void {
    this.fileInput?.nativeElement?.click();
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    const file = input.files[0];

    if (!file.type.startsWith('image/')) {
      alert('Please select an image file');
      input.value = '';
      return;
    }
    if (file.size > 1024 * 1024) {
      alert('Image file size must be less than 1MB');
      input.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const result = e.target?.result as string;
      const base64Content = result.split(',')[1] || result;
      this.iconSelected.emit({
        file,
        content: base64Content,
        preview: result
      });
    };
    reader.onerror = () => {
      alert('Failed to read image file');
      input.value = '';
    };
    reader.readAsDataURL(file);
  }

  onRemoveIcon(): void {
    this.iconRemoved.emit();
    this.resetFileInput();
  }

  resetFileInput(): void {
    if (this.fileInput?.nativeElement) {
      this.fileInput.nativeElement.value = '';
    }
  }
}
