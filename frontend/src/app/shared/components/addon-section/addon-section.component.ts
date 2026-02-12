import { Component, Input, Output, EventEmitter, signal } from '@angular/core';
import { FormGroup, ReactiveFormsModule } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { IAddonWithParameters, IParameter, IStack } from '../../../../shared/types';
import { ParameterGroupComponent } from '../../../ve-configuration-dialog/parameter-group.component';

/**
 * Reusable Addon Section Component
 *
 * Displays a list of optional addons with checkboxes and expandable parameter sections.
 * Used in:
 * - ve-configuration-dialog (main addon selection)
 * - (future) other dialogs that need addon selection
 */
@Component({
  selector: 'app-addon-section',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatCheckboxModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    ParameterGroupComponent
  ],
  template: `
    @if (loading()) {
      <div class="addons-loading">
        <mat-spinner diameter="24"></mat-spinner>
        <span>Loading addons...</span>
      </div>
    } @else if (availableAddons.length > 0) {
      <div class="addons-section">
        <h3>{{ title }}</h3>
        @if (description) {
          <p class="addons-description">{{ description }}</p>
        }
        <div class="addons-list">
          @for (addon of availableAddons; track addon.id) {
            <div class="addon-entry">
              <div class="addon-header">
                <mat-checkbox
                  [checked]="isAddonSelected(addon.id)"
                  (change)="onAddonToggle(addon.id, $event.checked)">
                  <div class="addon-item">
                    <span class="addon-name">{{ addon.name }}</span>
                    @if (addon.description) {
                      <span class="addon-description">{{ addon.description }}</span>
                    }
                  </div>
                </mat-checkbox>
                @if (isAddonSelected(addon.id) && hasAddonParameters(addon)) {
                  <button type="button" class="addon-configure-btn"
                          (click)="onToggleExpanded(addon.id, $event)">
                    <span class="configure-icon">{{ isAddonExpanded(addon.id) ? '▼' : '▶' }}</span>
                    <span class="configure-text">Configure</span>
                  </button>
                }
              </div>
              @if (isAddonSelected(addon.id) && isAddonExpanded(addon.id) && addon.parameters) {
                <div class="addon-parameters-inline">
                  @for (param of addon.parameters; track param.id) {
                    @if (!param.advanced || showAdvanced) {
                      <app-parameter-group
                        [groupName]="addon.name"
                        [groupedParameters]="getAddonGroupedParameters(addon.name, param)"
                        [form]="form"
                        [showAdvanced]="showAdvanced"
                        [availableStacks]="availableStacks"
                        (stackSelected)="stackSelected.emit($event)"
                        (createStackRequested)="createStackRequested.emit()"
                      />
                    }
                  }
                </div>
              }
            </div>
          }
        </div>
      </div>
    }
  `,
  styles: [`
    .addons-section {
      margin-bottom: 1rem;
    }

    .addons-section h3 {
      margin: 0 0 0.5rem 0;
      font-size: 1.1rem;
      font-weight: 500;
    }

    .addons-description {
      color: #666;
      font-size: 0.9rem;
      margin: 0 0 1rem 0;
    }

    .addons-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }

    .addon-entry {
      border: 1px solid #e0e0e0;
      border-radius: 4px;
      padding: 0.75rem;
    }

    .addon-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
    }

    .addon-item {
      display: flex;
      flex-direction: column;
    }

    .addon-name {
      font-weight: 500;
    }

    .addon-description {
      font-size: 0.85rem;
      color: #666;
      margin-top: 0.25rem;
    }

    .addon-configure-btn {
      display: flex;
      align-items: center;
      gap: 0.25rem;
      background: none;
      border: 1px solid #ccc;
      border-radius: 4px;
      padding: 0.25rem 0.5rem;
      cursor: pointer;
      font-size: 0.85rem;
      white-space: nowrap;
    }

    .addon-configure-btn:hover {
      background: #f5f5f5;
    }

    .configure-icon {
      font-size: 0.75rem;
    }

    .addon-parameters-inline {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid #e0e0e0;
    }

    .addons-loading {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      color: #666;
      padding: 1rem 0;
    }
  `]
})
export class AddonSectionComponent {
  /** Available addons to display */
  @Input() availableAddons: IAddonWithParameters[] = [];

  /** IDs of currently selected addons */
  @Input() selectedAddons: string[] = [];

  /** IDs of currently expanded addons */
  @Input() expandedAddons: string[] = [];

  /** Form group for addon parameters */
  @Input() form!: FormGroup;

  /** Whether to show advanced parameters */
  @Input() showAdvanced = false;

  /** Available stacks for stack selector */
  @Input() availableStacks: IStack[] = [];

  /** Section title */
  @Input() title = 'Optional Addons';

  /** Section description */
  @Input() description = 'Select additional features to install with this application';

  /** Loading state */
  loading = signal(false);

  /** Set loading state */
  @Input() set isLoading(value: boolean) {
    this.loading.set(value);
  }

  /** Emits when an addon is toggled */
  @Output() addonToggled = new EventEmitter<{ addonId: string; checked: boolean }>();

  /** Emits when an addon's expanded state changes */
  @Output() addonExpandedChanged = new EventEmitter<string>();

  /** Emits when a stack is selected */
  @Output() stackSelected = new EventEmitter<IStack>();

  /** Emits when create stack is requested */
  @Output() createStackRequested = new EventEmitter<void>();

  isAddonSelected(addonId: string): boolean {
    return this.selectedAddons.includes(addonId);
  }

  isAddonExpanded(addonId: string): boolean {
    return this.expandedAddons.includes(addonId);
  }

  hasAddonParameters(addon: IAddonWithParameters): boolean {
    return !!addon.parameters && addon.parameters.length > 0;
  }

  onAddonToggle(addonId: string, checked: boolean): void {
    this.addonToggled.emit({ addonId, checked });
  }

  onToggleExpanded(addonId: string, event: Event): void {
    event.stopPropagation();
    this.addonExpandedChanged.emit(addonId);
  }

  /**
   * Groups a single parameter for display in ParameterGroupComponent
   */
  getAddonGroupedParameters(groupName: string, param: IParameter): Record<string, IParameter[]> {
    return { [groupName]: [param] };
  }
}
