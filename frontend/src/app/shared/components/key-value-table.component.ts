import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatTooltipModule } from '@angular/material/tooltip';

export interface BooleanColumnConfig {
  field: string;           // Field name in flags object, e.g., 'required', 'advanced'
  label: string;           // Column header label
  icon?: string;           // Material icon name (optional)
  tooltip?: string;        // Tooltip text for the checkbox
}

export interface KeyValuePair {
  key: string;
  value: string | number;
  placeholder?: string;    // Optional per-row placeholder for value field
  readonly?: boolean;      // Optional per-row readonly flag for key field
  flags?: Record<string, boolean>;  // Dynamic boolean fields (required, advanced, etc.)
}

@Component({
  selector: 'app-key-value-table',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatRadioModule,
    MatCheckboxModule,
    MatTooltipModule
  ],
  template: `
    <div class="key-value-table" [style.--grid-columns]="getGridColumns()">
      @if (items().length > 0) {
        @for (item of items(); track $index; let idx = $index) {
          <div class="grid-row" [attr.data-testid]="'key-value-row-' + idx">
            @if (showRadio) {
              <div class="col radio">
                <mat-radio-button
                  [checked]="selectedIndex() === idx"
                  (change)="setSelected(idx)"
                  [attr.aria-label]="'Set current ' + keyLabel"
                ></mat-radio-button>
              </div>
            }
            <div class="col key">
              <mat-form-field appearance="fill" class="field">
                <input
                  matInput
                  [(ngModel)]="item.key"
                  [name]="'key' + idx"
                  [placeholder]="keyPlaceholder"
                  (blur)="onKeyChange(idx, item.key)"
                  [readonly]="readonly || item.readonly"
                  [attr.data-testid]="'key-input-' + idx"
                />
              </mat-form-field>
            </div>
            <div class="col value">
              <mat-form-field appearance="fill" class="field">
                @if (valueType === 'number') {
                  <input
                    matInput
                    type="number"
                    [(ngModel)]="item.value"
                    [name]="'value' + idx"
                    [placeholder]="item.placeholder || valuePlaceholder"
                    (blur)="onValueChange(idx, item.value)"
                    [readonly]="readonly"
                    [attr.data-testid]="'value-input-' + idx"
                  />
                } @else {
                  <input
                    matInput
                    [(ngModel)]="item.value"
                    [name]="'value' + idx"
                    [placeholder]="item.placeholder || valuePlaceholder"
                    (blur)="onValueChange(idx, item.value)"
                    [readonly]="readonly"
                    [attr.data-testid]="'value-input-' + idx"
                  />
                }
              </mat-form-field>
            </div>
            <!-- Dynamic boolean columns -->
            @for (col of booleanColumns; track col.field) {
              <div class="col boolean-col">
                <mat-checkbox
                  [checked]="!!item.flags?.[col.field]"
                  (change)="onBooleanChange(idx, col.field, $event.checked)"
                  [matTooltip]="col.tooltip || col.label"
                  [disabled]="readonly"
                  [attr.data-testid]="'boolean-' + col.field + '-' + idx"
                >
                  @if (col.icon) {
                    <mat-icon class="checkbox-icon">{{ col.icon }}</mat-icon>
                  } @else {
                    <span class="checkbox-label">{{ col.label }}</span>
                  }
                </mat-checkbox>
              </div>
            }
            @if (!readonly) {
              <div class="col actions">
                <button
                  type="button"
                  mat-icon-button
                  color="warn"
                  (click)="removeItem(idx)"
                  [attr.aria-label]="'Remove ' + keyLabel"
                  [attr.data-testid]="'delete-row-btn-' + idx"
                >
                  <mat-icon>delete</mat-icon>
                </button>
              </div>
            }
          </div>
        }
      }

      @if (!readonly) {
        <!-- Add row -->
        <div class="grid-row add-row" data-testid="add-row">
          @if (showRadio) {
            <div class="col radio">
              <mat-radio-button [checked]="false" disabled [attr.aria-label]="'Set current (new) ' + keyLabel"></mat-radio-button>
            </div>
          }
          <div class="col key">
            <mat-form-field appearance="fill" class="field">
              <input
                matInput
                [(ngModel)]="newKey"
                name="newKey"
                [placeholder]="keyPlaceholder"
                (keyup.enter)="addItem()"
                data-testid="new-key-input"
              />
            </mat-form-field>
          </div>
          <div class="col value">
            <mat-form-field appearance="fill" class="field">
              @if (valueType === 'number') {
                <input
                  matInput
                  type="number"
                  [(ngModel)]="newValue"
                  name="newValue"
                  [placeholder]="valuePlaceholder"
                  (keyup.enter)="addItem()"
                  data-testid="new-value-input"
                />
              } @else {
                <input
                  matInput
                  [(ngModel)]="newValue"
                  name="newValue"
                  [placeholder]="valuePlaceholder"
                  (keyup.enter)="addItem()"
                  data-testid="new-value-input"
                />
              }
            </mat-form-field>
          </div>
          <!-- Placeholder for boolean columns in add row -->
          @for (col of booleanColumns; track col.field) {
            <div class="col boolean-col">
              <mat-checkbox
                [checked]="!!newFlags[col.field]"
                (change)="newFlags[col.field] = $event.checked"
                [matTooltip]="col.tooltip || col.label"
                [attr.data-testid]="'boolean-' + col.field + '-new'"
              >
                @if (col.icon) {
                  <mat-icon class="checkbox-icon">{{ col.icon }}</mat-icon>
                } @else {
                  <span class="checkbox-label">{{ col.label }}</span>
                }
              </mat-checkbox>
            </div>
          }
          <div class="col actions">
            <button
              type="button"
              mat-icon-button
              color="primary"
              (click)="addItem()"
              [attr.aria-label]="'Add ' + keyLabel"
              data-testid="add-row-btn"
            >
              <mat-icon>add</mat-icon>
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .key-value-table {
      width: 100%;
    }
    
    .grid-row {
      display: grid;
      gap: 0.5rem;
      align-items: start;
      margin-bottom: 0.5rem;
    }
    
    .grid-row:not(.add-row) {
      grid-template-columns: var(--grid-columns, 1fr 1fr auto);
    }
    
    .add-row {
      grid-template-columns: var(--grid-columns, 1fr 1fr auto);
    }
    
    .col.radio {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      width: auto;
    }
    
    .col {
      display: flex;
      align-items: center;
    }
    
    .col.key {
      min-width: 0;
    }
    
    .col.value {
      min-width: 0;
    }
    
    .col.actions {
      flex-shrink: 0;
      width: auto;
    }
    
    .field {
      width: 100%;
    }
    
    .add-row {
      margin-top: 0.5rem;
    }

    .col.boolean-col {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .checkbox-icon {
      font-size: 18px;
      height: 18px;
      width: 18px;
    }

    .checkbox-label {
      font-size: 12px;
    }
  `]
})
export class KeyValueTableComponent {
  @Input() items = signal<KeyValuePair[]>([]);
  @Input() keyPlaceholder = 'Key';
  @Input() valuePlaceholder = 'Value';
  @Input() keyLabel = 'item';
  @Input() valueType: 'text' | 'number' = 'text';
  @Input() readonly = false;
  @Input() showRadio = false;
  @Input() selectedIndex = signal<number | null>(null);
  @Input() booleanColumns: BooleanColumnConfig[] = [];

  @Output() itemsChange = new EventEmitter<KeyValuePair[]>();
  @Output() selectedIndexChange = new EventEmitter<number | null>();

  newKey = '';
  newValue: string | number = '';
  newFlags: Record<string, boolean> = {};

  getGridColumns(): string {
    const parts: string[] = [];
    if (this.showRadio) parts.push('40px');
    parts.push('1fr');  // key
    parts.push('1fr');  // value
    for (const _ of this.booleanColumns) {
      parts.push('auto');  // each boolean column
    }
    if (!this.readonly) parts.push('48px');  // actions
    return parts.join(' ');
  }
  
  onKeyChange(index: number, key: string): void {
    const currentItems = [...this.items()];
    currentItems[index].key = key;
    this.items.set(currentItems);
    this.itemsChange.emit(currentItems);
  }
  
  onValueChange(index: number, value: string | number): void {
    const currentItems = [...this.items()];
    if (this.valueType === 'number') {
      currentItems[index].value = Number(value) || 0;
    } else {
      currentItems[index].value = String(value);
    }
    this.items.set(currentItems);
    this.itemsChange.emit(currentItems);
  }

  onBooleanChange(index: number, field: string, checked: boolean): void {
    const currentItems = [...this.items()];
    const item = currentItems[index];
    if (!item.flags) {
      item.flags = {};
    }
    item.flags[field] = checked;
    this.items.set(currentItems);
    this.itemsChange.emit(currentItems);
  }

  addItem(): void {
    const key = String(this.newKey || '').trim();
    const value = this.valueType === 'number'
      ? (Number(this.newValue) || 0)
      : String(this.newValue || '').trim();

    if (!key) {
      return;
    }

    // Prevent duplicate keys
    if (this.items().some(item => item.key === key)) {
      return;
    }

    // Copy flags if any boolean columns are configured
    const flags = this.booleanColumns.length > 0 ? { ...this.newFlags } : undefined;
    const newItem: KeyValuePair = { key, value };
    if (flags && Object.keys(flags).length > 0) {
      newItem.flags = flags;
    }

    const currentItems = [...this.items(), newItem];
    this.items.set(currentItems);
    this.itemsChange.emit(currentItems);

    this.newKey = '';
    this.newValue = this.valueType === 'number' ? 0 : '';
    this.newFlags = {};
  }
  
  removeItem(index: number): void {
    const currentItems = [...this.items()];
    const wasSelected = this.selectedIndex() === index;
    currentItems.splice(index, 1);
    this.items.set(currentItems);
    this.itemsChange.emit(currentItems);
    
    // Update selected index if needed
    if (wasSelected) {
      if (currentItems.length > 0) {
        this.setSelected(0);
      } else {
        this.setSelected(null);
      }
    } else if (this.selectedIndex() !== null && this.selectedIndex()! > index) {
      this.setSelected(this.selectedIndex()! - 1);
    }
  }
  
  setSelected(index: number | null): void {
    this.selectedIndex.set(index);
    this.selectedIndexChange.emit(index);
  }
}
