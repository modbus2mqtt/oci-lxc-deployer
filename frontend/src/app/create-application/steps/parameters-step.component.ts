import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';

import { CreateApplicationStateService } from '../services/create-application-state.service';
import { ParameterGroupComponent } from '../../ve-configuration-dialog/parameter-group.component';

@Component({
  selector: 'app-parameters-step',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatButtonModule,
    ParameterGroupComponent
  ],
  template: `
    <div class="step-content">
      @if (state.loadingParameters()) {
        <p>Loading parameters...</p>
      } @else {

        @if (hasAdvancedParams()) {
          <div class="advanced-toggle">
            <button mat-button (click)="toggleAdvanced()">
              {{ state.showAdvanced() ? 'Hide' : 'Show' }} Advanced Parameters
            </button>
          </div>
        }

        @for (groupName of groupNames; track groupName) {
          <app-parameter-group
            [groupName]="groupName"
            [groupedParameters]="state.groupedParameters()"
            [form]="state.parameterForm"
            [showAdvanced]="state.showAdvanced()"
          ></app-parameter-group>
        }

        @if (state.parameters().length === 0) {
          <p>No parameters to configure for this framework.</p>
        }
      }
    </div>
  `,
  styles: [`
    .step-content {
      padding: 1rem 0;
    }

    .advanced-toggle {
      margin-bottom: 1rem;
    }
  `]
})
export class ParametersStepComponent {
  readonly state = inject(CreateApplicationStateService);

  toggleAdvanced(): void {
    this.state.showAdvanced.set(!this.state.showAdvanced());
  }

  hasAdvancedParams(): boolean {
    return this.state.parameters().some(p => p.advanced);
  }

  get groupNames(): string[] {
    return Object.keys(this.state.groupedParameters());
  }
}
