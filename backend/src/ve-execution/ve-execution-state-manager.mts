import { IVMContext } from "../backend-types.mjs";
import { VMContext } from "../context-manager.mjs";
import { IRestartInfo } from "./ve-execution-constants.mjs";

export interface StateManagerDependencies {
  outputs: Map<string, string | number | boolean>;
  outputsRaw: { name: string; value: string | number | boolean }[] | undefined;
  inputs: Record<string, string | number | boolean>;
  defaults: Map<string, string | number | boolean>;
  veContext: { host: string | { host: string; port?: number }; port?: number; getKey?: () => string } | null;
  initializeVariableResolver: () => void;
}

/**
 * Handles state management for VeExecution.
 */
export class VeExecutionStateManager {
  constructor(private deps: StateManagerDependencies) {}

  /**
   * Restores state from restart info and returns the starting index.
   */
  restoreStateFromRestartInfo(restartInfo: IRestartInfo | null): number {
    if (!restartInfo) return 0;

    // Load previous state
    this.deps.outputs.clear();
    this.deps.inputs = {};
    this.deps.defaults.clear();
    const startIdx = restartInfo.lastSuccessfull !== undefined ? restartInfo.lastSuccessfull + 1 : 0;
    
    for (const inp of restartInfo.inputs) {
      this.deps.inputs[inp.name] = inp.value;
    }
    for (const outp of restartInfo.outputs) {
      this.deps.outputs.set(outp.name, outp.value);
    }
    for (const def of restartInfo.defaults) {
      this.deps.defaults.set(def.name, def.value);
    }
    
    // Re-initialize variable resolver with updated state
    this.deps.initializeVariableResolver();
    
    return startIdx;
  }

  /**
   * Builds restart info object from current state.
   */
  buildRestartInfo(lastSuccessIndex: number): IRestartInfo {
    const vm_id = this.deps.outputs.get("vm_id");
    return {
      vm_id:
        vm_id !== undefined
          ? Number.parseInt(vm_id as string, 10)
          : undefined,
      lastSuccessfull: lastSuccessIndex,
      inputs: Object.entries(this.deps.inputs).map(([name, value]) => ({
        name,
        value,
      })),
      outputs:
        this.deps.outputsRaw && Array.isArray(this.deps.outputsRaw)
          ? this.deps.outputsRaw.map(({ name, value }) => ({ name, value }))
          : Array.from(this.deps.outputs.entries()).map(([name, value]) => ({
              name,
              value,
            })),
      defaults: Array.from(this.deps.defaults.entries()).map(
        ([name, value]) => ({ name, value }),
      ),
    };
  }

  /**
   * Builds VMContext from current state.
   */
  buildVmContext(): IVMContext {
    if (!this.deps.veContext) {
      throw new Error("VE context not set");
    }
    var data: any = {};
    data.vmid = this.deps.outputs.get("vm_id");
    const hostVal = (this.deps.veContext as any)?.host;
    const veKey =
      typeof (this.deps.veContext as any)?.getKey === "function"
        ? (this.deps.veContext as any).getKey()
        : typeof hostVal === "string"
          ? `ve_${hostVal}`
          : undefined;
    data.vekey = veKey;
    data.data = {};

    this.deps.outputs.forEach((value, key) => {
      data.data[key] = value;
    });
    return new VMContext(data);
  }
}

