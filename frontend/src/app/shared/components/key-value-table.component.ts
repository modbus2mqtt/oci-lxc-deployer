import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';

export interface KeyValuePair {
  key: string;
  value: string | number;
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
    MatRadioModule
  ],
  template: `
    <div class="key-value-table" [style.--grid-columns]="showRadio ? '40px 1fr 140px 48px' : '1fr 1fr auto'">
      @if (items().length > 0) {
        @for (item of items(); track $index; let idx = $index) {
          <div class="grid-row">
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
                  [readonly]="readonly"
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
                    [placeholder]="valuePlaceholder"
                    (blur)="onValueChange(idx, item.value)"
                    [readonly]="readonly"
                  />
                } @else {
                  <input 
                    matInput 
                    [(ngModel)]="item.value" 
                    [name]="'value' + idx" 
                    [placeholder]="valuePlaceholder"
                    (blur)="onValueChange(idx, item.value)"
                    [readonly]="readonly"
                  />
                }
              </mat-form-field>
            </div>
            @if (!readonly) {
              <div class="col actions">
                <button 
                  type="button" 
                  mat-icon-button 
                  color="warn" 
                  (click)="removeItem(idx)" 
                  [attr.aria-label]="'Remove ' + keyLabel"
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
        <div class="grid-row add-row">
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
                />
              } @else {
                <input 
                  matInput 
                  [(ngModel)]="newValue" 
                  name="newValue" 
                  [placeholder]="valuePlaceholder"
                  (keyup.enter)="addItem()"
                />
              }
            </mat-form-field>
          </div>
          <div class="col actions">
            <button 
              type="button" 
              mat-icon-button 
              color="primary" 
              (click)="addItem()" 
              [attr.aria-label]="'Add ' + keyLabel"
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
  
  @Output() itemsChange = new EventEmitter<KeyValuePair[]>();
  @Output() selectedIndexChange = new EventEmitter<number | null>();
  
  newKey = '';
  newValue: string | number = '';
  
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
    
    const currentItems = [...this.items(), { key, value }];
    this.items.set(currentItems);
    this.itemsChange.emit(currentItems);
    
    this.newKey = '';
    this.newValue = this.valueType === 'number' ? 0 : '';
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
