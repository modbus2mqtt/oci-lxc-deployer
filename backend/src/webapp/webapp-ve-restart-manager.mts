import { IPostVeConfigurationBody } from "@src/types.mjs";
import { IRestartInfo } from "@src/ve-execution/ve-execution-constants.mjs";

/**
 * Manages restart information for execution retries.
 */
export class WebAppVeRestartManager {
  private restartInfos: Map<string, IRestartInfo> = new Map();

  /**
   * Stores restart information for a given restart key.
   */
  storeRestartInfo(restartKey: string, restartInfo: IRestartInfo): void {
    this.restartInfos.set(restartKey, restartInfo);
  }

  /**
   * Retrieves restart information for a given restart key.
   */
  getRestartInfo(restartKey: string): IRestartInfo | undefined {
    return this.restartInfos.get(restartKey);
  }

  /**
   * Creates a fallback restart info when execution fails before producing a result.
   */
  createFallbackRestartInfo(
    params: IPostVeConfigurationBody["params"],
  ): IRestartInfo {
    return {
      lastSuccessfull: -1,
      inputs: params.map((p) => ({ name: p.name, value: p.value })),
      outputs: [],
      defaults: [],
    };
  }
}
