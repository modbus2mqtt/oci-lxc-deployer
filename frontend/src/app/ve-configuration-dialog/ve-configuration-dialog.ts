import { Component, OnInit, OnDestroy, inject, signal, Input, computed } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';

import { ReactiveFormsModule, FormBuilder, FormGroup, Validators, FormControl } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { IApplicationWeb, IParameter, IParameterValue, IEnumValuesResponse, IAddonWithParameters, IStack, IStacktypeEntry } from '../../shared/types';
import { VeConfigurationService, VeConfigurationParam } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { DockerComposeService } from '../shared/services/docker-compose.service';
import { ParameterGroupComponent } from './parameter-group.component';
import { TemplateTraceDialog } from './template-trace-dialog';
import { CreateStackDialog, CreateStackDialogData, CreateStackDialogResult } from '../stacks-page/create-stack-dialog';
import type { NavigationExtras } from '@angular/router';

/**
 * Data passed to the VeConfigurationDialog.
 * - app: The application to configure
 * - task: The task type (installation, addon, etc.)
 * - presetValues: Optional preset values for parameters (e.g., from existing container)
 */
export interface VeConfigurationDialogData {
  app: IApplicationWeb;
  task?: string;
  presetValues?: Record<string, string | number>;
  existingMountPoints?: { source: string; target: string }[];
}
@Component({
  selector: 'app-ve-configuration-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    ReactiveFormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatIconModule,
    MatSelectModule,
    MatFormFieldModule,
    MatTooltipModule,
    ParameterGroupComponent
],
  templateUrl: './ve-configuration-dialog.html',
  styleUrl: './ve-configuration-dialog.scss',
})
export class VeConfigurationDialog implements OnInit, OnDestroy {
  form: FormGroup;
  unresolvedParameters: IParameter[] = [];
  groupedParameters: Record<string, IParameter[]> = {};
  loading = signal(true);
  hasError = signal(false);
  showAdvanced = signal(false);
  availableAddons: IAddonWithParameters[] = [];
  selectedAddons = signal<string[]>([]);
  expandedAddons = signal<string[]>([]);
  addonsLoading = signal(false);

  // Stack selection state
  availableStacks = signal<IStack[]>([]);
  filteredStacks = computed(() => {
    const stacktype = this.data.app.stacktype;
    if (!stacktype) return [];
    return this.availableStacks().filter(s => s.stacktype === stacktype);
  });
  availableStacktypes = signal<IStacktypeEntry[]>([]);
  stacksLoading = signal(false);
  selectedStack: IStack | null = null;
  private initialValues = new Map<string, IParameterValue>();
  private enumRefreshAttempted = false;
  private hostnameManuallyChanged = false;
  private visibilityHandler = () => this.onVisibilityChange();
  private configService: VeConfigurationService = inject(VeConfigurationService);
  public dialogRef: MatDialogRef<VeConfigurationDialog> = inject(MatDialogRef<VeConfigurationDialog>);
  private errorHandler: ErrorHandlerService = inject(ErrorHandlerService);
  private fb: FormBuilder = inject(FormBuilder);
  private dialog = inject(MatDialog);
  private composeService = inject(DockerComposeService);
  public data = inject(MAT_DIALOG_DATA) as VeConfigurationDialogData;
  private task = this.data.task ?? 'installation';
  private presetValues = this.data.presetValues ?? {};
  existingMountPoints: { source: string; target: string }[] = this.data.existingMountPoints ?? [];
  constructor(  ) {
    this.form = this.fb.group({});
  }
  ngOnInit(): void {
    // Listen for tab focus to reload stacks after editing in new tab
    document.addEventListener('visibilitychange', this.visibilityHandler);

    // Load compatible addons and stacks in parallel with parameters
    this.loadCompatibleAddons();
    this.loadStacks();

    // For demo purposes: use 'installation' as the default task, can be extended
    this.configService.getUnresolvedParameters(this.data.app.id, this.task).subscribe({
      next: (res) => {
        this.unresolvedParameters = res.unresolvedParameters;
        // Group parameters by template (filter out addon_ parameters - they are set by addons only)
        this.groupedParameters = {};
        for (const param of this.unresolvedParameters) {
          // Skip addon_ parameters - they are internal and set by addon templates
          if (param.id.startsWith('addon_')) {
            continue;
          }
          const group = param.templatename || 'General';
          if (!this.groupedParameters[group]) this.groupedParameters[group] = [];
          this.groupedParameters[group].push(param);
          const validators = param.required ? [Validators.required] : [];
          // Use preset value if available, otherwise use parameter default
          const presetValue = this.presetValues[param.id];
          if (presetValue !== undefined) {
            param.default = presetValue;
          }
          const defaultValue = param.default !== undefined ? param.default : '';
          this.form.addControl(param.id, new FormControl(defaultValue, validators));
          // Store initial value for comparison
          this.initialValues.set(param.id, defaultValue);
        }
        // Sort parameters in each group: required first, then optional
        for (const group in this.groupedParameters) {
          this.groupedParameters[group] = this.groupedParameters[group].slice().sort((a, b) => Number(!!b.required) - Number(!!a.required));
        }

        this.form.markAllAsTouched();
        this.loading.set(false);
        this.loadEnumValues();

        // Track manual hostname changes
        this.form.get('hostname')?.valueChanges.subscribe(value => {
          const initial = this.initialValues.get('hostname');
          if (value !== initial && value !== `${initial}-${this.selectedStack?.id}`) {
            this.hostnameManuallyChanged = true;
          }
        });
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to load parameters', err);
        this.loading.set(false);
        this.hasError.set(true);
        // Note: Dialog remains open so user can see the error and close manually
      }
    });
  }

  private loadEnumValues(): void {
    const enumParams = this.unresolvedParameters.filter((p) => p.type === 'enum');
    if (enumParams.length === 0) return;
    const allEnumsPresent = enumParams.every(
      (p) => Array.isArray(p.enumValues) && p.enumValues.length > 0,
    );
    if (allEnumsPresent) return;

    const params = enumParams
      .map((p) => ({
        id: p.id,
        value: this.form.get(p.id)?.value as IParameterValue,
      }))
      .filter((p) => p.value !== null && p.value !== undefined && p.value !== '');

    this.configService.postEnumValues(this.data.app.id, this.task, params).subscribe({
      next: (res: IEnumValuesResponse) => {
        for (const entry of res.enumValues) {
          const param = this.unresolvedParameters.find((p) => p.id === entry.id);
          if (!param) continue;
          param.enumValues = entry.enumValues;
          if (entry.default !== undefined) {
            param.default = entry.default;
            const control = this.form.get(entry.id);
            if (control && (control.value === '' || control.value === null || control.value === undefined)) {
              control.setValue(entry.default);
              this.initialValues.set(entry.id, entry.default as IParameterValue);
            }
          }
        }
        const missingEnums = this.unresolvedParameters.filter(
          (p) => p.type === 'enum' && (!p.enumValues || p.enumValues.length === 0),
        );
        if (missingEnums.length > 0 && !this.enumRefreshAttempted) {
          this.enumRefreshAttempted = true;
          this.configService.postEnumValues(this.data.app.id, this.task, params, true).subscribe({
            next: (retryRes: IEnumValuesResponse) => {
              for (const entry of retryRes.enumValues) {
                const param = this.unresolvedParameters.find((p) => p.id === entry.id);
                if (!param) continue;
                param.enumValues = entry.enumValues;
                if (entry.default !== undefined) {
                  param.default = entry.default;
                  const control = this.form.get(entry.id);
                  if (control && (control.value === '' || control.value === null || control.value === undefined)) {
                    control.setValue(entry.default);
                    this.initialValues.set(entry.id, entry.default as IParameterValue);
                  }
                }
              }
            },
            error: (err: unknown) => {
              this.errorHandler.handleError('Failed to refresh enum values', err);
            }
          });
        }
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to load enum values', err);
      }
    });
  }

  private loadCompatibleAddons(): void {
    this.addonsLoading.set(true);
    this.configService.getCompatibleAddons(this.data.app.id).subscribe({
      next: (res) => {
        this.availableAddons = res.addons;
        this.addonsLoading.set(false);
      },
      error: () => {
        // Don't show error for addons - they're optional
        // Just set loading to false and continue without addons
        this.addonsLoading.set(false);
      }
    });
  }

  private loadStacks(): void {
    this.stacksLoading.set(true);
    // Load stacktypes first, then load all stacks
    this.configService.getStacktypes().subscribe({
      next: (res) => {
        this.availableStacktypes.set(res.stacktypes);
        // Load all stacks (no filter - show all available)
        this.configService.getStacks().subscribe({
          next: (stacksRes) => {
            this.availableStacks.set(stacksRes.stacks);
            this.stacksLoading.set(false);
            // Auto-select if only one stack matches
            const filtered = this.filteredStacks();
            if (filtered.length === 1) {
              this.onStackSelected(filtered[0]);
            }
          },
          error: () => {
            // Don't show error for stacks - they're optional
            this.stacksLoading.set(false);
          }
        });
      },
      error: () => {
        // Don't show error for stacktypes - they're optional
        this.stacksLoading.set(false);
      }
    });
  }

  onStackSelected(stack: IStack): void {
    // Stack is selected - marker replacement happens in backend
    // Store the selected stack for later use
    this.selectedStack = stack;

    // Auto-update hostname if not manually modified and stack is not "default"
    if (!this.hostnameManuallyChanged && stack.name.toLowerCase() !== 'default') {
      const hostnameControl = this.form.get('hostname');
      const baseHostname = this.initialValues.get('hostname');
      if (hostnameControl && baseHostname) {
        hostnameControl.setValue(`${baseHostname}-${stack.id}`);
      }
    }
  }

  onStackSelectChange(stackId: string): void {
    const stack = this.filteredStacks().find(s => s.id === stackId);
    if (stack) {
      this.onStackSelected(stack);
    }
  }

  onCreateStackRequested(): void {
    // Get markers that need to be filled
    const envMarkers = this.composeService.extractMarkers(this.form.get('envs')?.value || '');
    const envFileMarkers = this.composeService.extractMarkersFromBase64(this.form.get('env_file')?.value || '');
    const suggestedEntries = [...new Set([...envMarkers, ...envFileMarkers])];

    const dialogData: CreateStackDialogData = {
      stacktypes: this.availableStacktypes(),
      suggestedEntries
    };

    const dialogRef = this.dialog.open(CreateStackDialog, {
      width: '600px',
      data: dialogData
    });

    dialogRef.afterClosed().subscribe((result: CreateStackDialogResult | undefined) => {
      if (result?.stack) {
        // Add to available stacks and apply it
        this.availableStacks.update(stacks => [...stacks, result.stack]);
        this.onStackSelected(result.stack);
      }
    });
  }

  toggleAddon(addonId: string, checked: boolean): void {
    const addon = this.availableAddons.find(a => a.id === addonId);

    if (checked) {
      this.selectedAddons.update(addons => [...addons, addonId]);
      // Add form controls for addon parameters
      if (addon?.parameters) {
        for (const param of addon.parameters) {
          if (!this.form.contains(param.id)) {
            const validators = param.required ? [Validators.required] : [];
            const defaultValue = param.default !== undefined ? param.default : '';
            this.form.addControl(param.id, new FormControl(defaultValue, validators));
            this.initialValues.set(param.id, defaultValue);
          }
        }
      }
    } else {
      this.selectedAddons.update(addons => addons.filter(id => id !== addonId));
      // Collapse addon when deselected
      this.expandedAddons.update(addons => addons.filter(id => id !== addonId));
      // Remove form controls for addon parameters
      if (addon?.parameters) {
        for (const param of addon.parameters) {
          if (this.form.contains(param.id)) {
            this.form.removeControl(param.id);
            this.initialValues.delete(param.id);
          }
        }
      }
    }
  }

  isAddonSelected(addonId: string): boolean {
    return this.selectedAddons().includes(addonId);
  }

  isAddonExpanded(addonId: string): boolean {
    return this.expandedAddons().includes(addonId);
  }

  toggleAddonExpanded(addonId: string, event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.expandedAddons.update(addons =>
      addons.includes(addonId)
        ? addons.filter(id => id !== addonId)
        : [...addons, addonId]
    );
  }

  hasAddonParameters(addon: IAddonWithParameters): boolean {
    return (addon.parameters?.length ?? 0) > 0;
  }

  getSelectedAddonParameters(): { addon: IAddonWithParameters; parameters: IParameter[] }[] {
    return this.selectedAddons()
      .map(addonId => this.availableAddons.find(a => a.id === addonId))
      .filter((addon): addon is IAddonWithParameters => addon !== undefined && (addon.parameters?.length ?? 0) > 0)
      .map(addon => ({ addon, parameters: addon.parameters! }));
  }

  getAddonGroupedParameters(addonName: string, param: IParameter): Record<string, IParameter[]> {
    const result: Record<string, IParameter[]> = {};
    result[addonName] = [param];
    return result;
  }

  @Input() customActions?: boolean;

  save() {
    if (this.form.invalid) return;
    this.loading.set(true);
    
    // Separate params and changed parameters
    const params: VeConfigurationParam[] = [];
    const changedParams: VeConfigurationParam[] = [];
    
    for (const [paramId, currentValue] of Object.entries(this.form.value) as [string, IParameterValue][]) {
      const initialValue = this.initialValues.get(paramId);
      
      // Extract base64 content if value has file metadata format: file:filename:content:base64content
      let processedValue: IParameterValue = currentValue;
      if (typeof currentValue === 'string' && currentValue.match(/^file:[^:]+:content:(.+)$/)) {
        const match = currentValue.match(/^file:[^:]+:content:(.+)$/);
        if (match) {
          processedValue = match[1]; // Extract only the base64 content
        }
      }
      
      // Check if value has changed (compare with initial value)
      const hasChanged = initialValue !== processedValue && 
                        (processedValue !== null && processedValue !== undefined && processedValue !== '');
      
      if (hasChanged) {
        // Collect changed parameters for vmInstallContext
        if (processedValue !== null && processedValue !== undefined && processedValue !== '') {
          changedParams.push({ name: paramId, value: processedValue });
          params.push({ name: paramId, value: processedValue });
        }
      } else if (processedValue !== null && processedValue !== undefined && processedValue !== '') {
        // Include unchanged values that are not empty (for required fields)
        params.push({ name: paramId, value: processedValue });
      }
    }
    
    const application = this.data.app.id;
    const task = this.task;
    
    // Pass changedParams and selectedAddons to backend for vmInstallContext
        this.configService.postVeConfiguration(
          application,
          task,
          params,
          changedParams.length > 0 ? changedParams : undefined,
          this.selectedAddons().length > 0 ? this.selectedAddons() : undefined
        ).subscribe({
          next: (res) => {
            this.loading.set(false);
            // Navigate to process monitor; pass restartKey, vmInstallKey and original parameters
            const extras: NavigationExtras = {
              queryParams: res.restartKey ? { restartKey: res.restartKey } : {},
              state: { 
                originalParams: params,
                application: application,
                task: task,
                restartKey: res.restartKey,
                vmInstallKey: res.vmInstallKey
              }
            };
            this.dialogRef.close(this.form.value);
            this.configService['router'].navigate(['/monitor'], extras);
          },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to install configuration', err);
        this.loading.set(false);
      }
    });
  }

  close(): void {
    this.dialogRef.close();
  }

  toggleAdvanced(): void {
    this.showAdvanced.set(!this.showAdvanced());
  }

  hasAdvancedParams(): boolean {
    return this.unresolvedParameters.some(p => p.advanced);
  }

  get missingRequiredParams(): IParameter[] {
    return this.unresolvedParameters.filter((p) => {
      // Skip if not required or has a default value
      if (p.required !== true || (p.default !== undefined && p.default !== null && p.default !== '')) {
        return false;
      }
      // Skip if param has an 'if' condition and the condition is not met
      if (p.if && !this.evaluateCondition(p.if)) {
        return false;
      }
      return true;
    });
  }

  /**
   * Evaluates a condition for param.if.
   * Special conditions like 'env_file_has_markers' are computed from other controls.
   */
  private evaluateCondition(condition: string): boolean {
    // Special: env_file_has_markers - check if envs or env_file contains {{ }} markers
    if (condition === 'env_file_has_markers') {
      // Check envs for markers (oci-image case)
      const envsValue = this.form.get('envs')?.value;
      if (this.composeService.hasMarkers(envsValue)) {
        return true;
      }
      // Check env_file for markers (docker-compose case)
      const envFileValue = this.form.get('env_file')?.value;
      if (envFileValue && this.composeService.hasMarkersInBase64(envFileValue)) {
        return true;
      }
      return false;
    }
    // Default: check form control value
    return !!this.form.get(condition)?.value;
  }

  get showMissingRequiredHint(): boolean {
    return this.missingRequiredParams.length > 0;
  }

  get missingRequiredParamsLabel(): string {
    return this.missingRequiredParams.map((p) => p.id).join(', ');
  }

  get taskKey(): string {
    return this.task;
  }

  openTemplateTrace(): void {
    this.configService.getTemplateTrace(this.data.app.id, this.task).subscribe({
      next: (trace) => {
        this.dialog.open(TemplateTraceDialog, {
          width: '900px',
          data: {
            applicationName: this.data.app.name,
            task: this.task,
            trace,
            missingRequiredIds: this.missingRequiredParams.map((param) => param.id),
          },
        });
      },
      error: (err: unknown) => {
        this.errorHandler.handleError('Failed to load template trace', err);
      }
    });
  }


  get groupNames(): string[] {
    return Object.keys(this.groupedParameters);
  }

  ngOnDestroy(): void {
    document.removeEventListener('visibilitychange', this.visibilityHandler);
  }

  private onVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      // Reload stacks when tab becomes visible again
      this.reloadStacks();
    }
  }

  private reloadStacks(): void {
    const previousSelectedId = this.selectedStack?.id;
    this.configService.getStacks().subscribe({
      next: (res) => {
        this.availableStacks.set(res.stacks);
        // Re-select previously selected stack or auto-select if only one
        const filtered = this.filteredStacks();
        if (previousSelectedId) {
          const found = filtered.find(s => s.id === previousSelectedId);
          if (found) {
            this.selectedStack = found;
          } else if (filtered.length === 1) {
            this.selectedStack = filtered[0];
          }
        } else if (filtered.length === 1) {
          this.selectedStack = filtered[0];
        }
      }
    });
  }
}
