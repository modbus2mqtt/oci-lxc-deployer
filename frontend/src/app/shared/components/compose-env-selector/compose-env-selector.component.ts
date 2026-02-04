import { CommonModule } from '@angular/common';
import { Component, EventEmitter, input, Input, Output, signal } from '@angular/core';
import { FormGroup, FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ComposeService } from '../../services/docker-compose.service';

export type ComposeEnvSelectorMode = 'multi' | 'single';

@Component({
  selector: 'app-compose-env-selector',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatTooltipModule,
    MatSelectModule
  ],
  templateUrl: `compose-env-selector.component.html`,
  styleUrls: [`compose-env-selector.component.scss`]
})
export class ComposeEnvSelectorComponent {
  @Input() parameterForm!: FormGroup;
  @Input() mode: ComposeEnvSelectorMode = 'multi';

  // Use Angular's input() signals for reactive updates when parent values change
  services = input<ComposeService[]>([]);
  selectedServiceName = input<string>('');
  requiredEnvVars = input<string[]>([]);
  missingEnvVars = input<string[]>([]);
  composeProperties = input<{
    services?: string;
    ports?: string;
    images?: string;
    networks?: string;
    volumes?: string;
  } | null>(null);

  // Emittiere nur raw file changes, kein Parsing
  @Output() composeFileSelected = new EventEmitter<File>();
  @Output() envFileSelected = new EventEmitter<File>();
  @Output() serviceSelected = new EventEmitter<string>();

  composeFileName = signal<string>('');
  envFileName = signal<string>('');
  composeFileError = signal<string | null>(null);
  envFileError = signal<string | null>(null);
  hasEnvFile = signal<boolean>(false);

  async onComposeFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      this.composeFileName.set(file.name);
      this.composeFileSelected.emit(file);
    }
  }

  async onEnvFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      this.envFileName.set(file.name);
      this.hasEnvFile.set(true);
      this.envFileSelected.emit(file);
    } else {
      this.hasEnvFile.set(false);
      this.envFileName.set('');
    }
  }

  onServiceSelected(serviceName: string): void {
    this.serviceSelected.emit(serviceName);
  }

  getEnvFileTooltip(): string {
    return this.requiredEnvVars().length > 0
      ? `Required: .env file must contain all environment variables from docker-compose.yml`
      : 'Optional: Upload your .env file';
  }

  hasMissingEnvVars(): boolean {
    return this.missingEnvVars().length > 0;
  }

  getServiceNames(): string {
    return this.services().map(s => s.name).join(', ');
  }
}
