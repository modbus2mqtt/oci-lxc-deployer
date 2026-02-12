import { FormControl, FormGroup, Validators } from '@angular/forms';
import { Router, NavigationExtras } from '@angular/router';
import { Observable, tap } from 'rxjs';
import { IParameter, IParameterValue, IStack } from '../../../shared/types';
import { VeConfigurationService, VeConfigurationParam } from '../../ve-configuration.service';

export interface ChangedParamsResult {
  params: VeConfigurationParam[];
  changedParams: VeConfigurationParam[];
}

export interface InstallResult {
  success: boolean;
  restartKey?: string;
  vmInstallKey?: string;
}

/**
 * Kapselt FormGroup + initialValues + Change-Detection + Installation
 * Verwendet von: summary-step, ve-configuration-dialog
 */
export class ParameterFormManager {
  readonly form: FormGroup;
  private readonly initialValues = new Map<string, IParameterValue>();
  private selectedAddons: string[] = [];
  private selectedStack: IStack | null = null;

  constructor(
    params: IParameter[],
    private configService?: VeConfigurationService,
    private router?: Router
  ) {
    const group: Record<string, FormControl> = {};

    for (const param of params) {
      const validators = param.required ? [Validators.required] : [];
      const defaultValue = param.default ?? '';
      group[param.id] = new FormControl(defaultValue, validators);
      this.initialValues.set(param.id, defaultValue);
    }

    this.form = new FormGroup(group);
  }

  /** Für ve-configuration-dialog: Form von außen setzen, initialValues tracken */
  static fromExistingForm(
    form: FormGroup,
    configService: VeConfigurationService,
    router: Router
  ): ParameterFormManager {
    // Create instance with empty params, then set properties
    const manager = new ParameterFormManager([], configService, router);
    // Override the form with the existing one
    (manager as unknown as { form: FormGroup }).form = form;

    // Capture initial values from current form state
    for (const [key, value] of Object.entries(form.value)) {
      manager.updateInitialValue(key, value as IParameterValue);
    }
    return manager;
  }

  get valid(): boolean {
    return this.form.valid;
  }

  /** Setzt ausgewählte Addons (für ve-configuration-dialog) */
  setSelectedAddons(addons: string[]): void {
    this.selectedAddons = addons;
  }

  /** Gibt ausgewählte Addons zurück */
  getSelectedAddons(): string[] {
    return this.selectedAddons;
  }

  /** Setzt ausgewählten Stack und aktualisiert Hostname */
  setSelectedStack(stack: IStack | null): void {
    this.selectedStack = stack;

    // Auto-update hostname wenn Stack ausgewählt (nicht "default")
    if (stack && stack.name.toLowerCase() !== 'default') {
      const hostnameControl = this.form.get('hostname');
      const baseHostname = this.initialValues.get('hostname');
      if (hostnameControl && baseHostname) {
        hostnameControl.setValue(`${baseHostname}-${stack.id}`);
      }
    }
  }

  getSelectedStack(): IStack | null {
    return this.selectedStack;
  }

  /** Aktualisiert einen initialValue (z.B. wenn Enum-Defaults geladen werden) */
  updateInitialValue(key: string, value: IParameterValue): void {
    this.initialValues.set(key, value);
  }

  /** Gibt einen initialValue zurück */
  getInitialValue(key: string): IParameterValue | undefined {
    return this.initialValues.get(key);
  }

  /** Fügt Addon-Parameter zum Form hinzu (bei Addon-Auswahl) */
  addAddonControls(params: IParameter[]): void {
    for (const param of params) {
      if (!this.form.contains(param.id)) {
        const validators = param.required ? [Validators.required] : [];
        const defaultValue = param.default ?? '';
        this.form.addControl(param.id, new FormControl(defaultValue, validators));
        this.initialValues.set(param.id, defaultValue);
      }
    }
  }

  /** Entfernt Addon-Parameter vom Form (bei Addon-Abwahl) */
  removeAddonControls(params: IParameter[]): void {
    for (const param of params) {
      if (this.form.contains(param.id)) {
        this.form.removeControl(param.id);
        this.initialValues.delete(param.id);
      }
    }
  }

  /**
   * Extrahiert alle Parameter und geänderte Parameter
   */
  extractParamsWithChanges(): ChangedParamsResult {
    const params: VeConfigurationParam[] = [];
    const changedParams: VeConfigurationParam[] = [];

    for (const [paramId, currentValue] of Object.entries(this.form.value) as [string, IParameterValue][]) {
      const processedValue = this.extractBase64Content(currentValue);
      const initialValue = this.initialValues.get(paramId);

      const hasChanged = initialValue !== processedValue &&
        processedValue !== null && processedValue !== undefined && processedValue !== '';

      if (hasChanged) {
        changedParams.push({ name: paramId, value: processedValue });
        params.push({ name: paramId, value: processedValue });
      } else if (processedValue !== null && processedValue !== undefined && processedValue !== '') {
        params.push({ name: paramId, value: processedValue });
      }
    }

    return { params, changedParams };
  }

  /**
   * Führt Installation aus: postVeConfiguration + Navigation zu /monitor
   * Verwendet intern: params, changedParams, selectedAddons
   */
  install(
    applicationId: string,
    task = 'installation'
  ): Observable<InstallResult> {
    if (!this.configService || !this.router) {
      throw new Error('ParameterFormManager requires configService and router for install()');
    }

    const { params, changedParams } = this.extractParamsWithChanges();

    return this.configService.postVeConfiguration(
      applicationId,
      task,
      params,
      changedParams.length > 0 ? changedParams : undefined,
      this.selectedAddons.length > 0 ? this.selectedAddons : undefined
    ).pipe(
      tap((res) => {
        const extras: NavigationExtras = {
          queryParams: res.restartKey ? { restartKey: res.restartKey } : {},
          state: {
            originalParams: params,
            application: applicationId,
            task: task,
            restartKey: res.restartKey,
            vmInstallKey: res.vmInstallKey
          }
        };
        this.router!.navigate(['/monitor'], extras);
      })
    );
  }

  private extractBase64Content(value: IParameterValue): IParameterValue {
    if (typeof value === 'string' && value.match(/^file:[^:]+:content:(.+)$/)) {
      const match = value.match(/^file:[^:]+:content:(.+)$/);
      return match ? match[1] : value;
    }
    return value;
  }
}
