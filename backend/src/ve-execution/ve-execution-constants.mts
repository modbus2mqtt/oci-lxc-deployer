// Re-export IOutput for backward compatibility
export type { IOutput } from "../output-processor.mjs";

export interface IProxmoxRunResult {
  lastSuccessIndex: number;
}

export interface IRestartInfo {
  vm_id?: string | number | undefined;
  lastSuccessfull: number;
  inputs: { name: string; value: string | number | boolean }[];
  outputs: { name: string; value: string | number | boolean }[];
  defaults: { name: string; value: string | number | boolean }[];
}

/**
 * Execution mode for VeExecution.
 * Determines how commands are executed (SSH to remote host or locally for tests).
 */
export enum ExecutionMode {
  PRODUCTION = "production", // Uses SSH to connect to remote host
  TEST = "test", // Executes commands locally without SSH
}

/**
 * Determines execution mode from environment or explicit parameter.
 * Defaults to PRODUCTION if not in test environment.
 * @param explicitMode Optional explicit execution mode override
 * @returns The determined execution mode
 */
export function determineExecutionMode(
  explicitMode?: ExecutionMode,
): ExecutionMode {
  if (explicitMode !== undefined) {
    return explicitMode;
  }
  // Automatically detect test mode from environment
  if (
    process.env.NODE_ENV === "test" ||
    process.env.LXC_MANAGER_TEST_MODE === "true"
  ) {
    return ExecutionMode.TEST;
  }
  return ExecutionMode.PRODUCTION;
}

/**
 * Execution constants for VeExecution.
 */
export class VeExecutionConstants {
  static readonly DEFAULT_SCRIPT_TIMEOUT_MS = 120000; // 2 minutes
  static readonly HOST_PROBE_TIMEOUT_MS = 10000; // 10 seconds
  static readonly RETRY_DELAY_MS = 3000; // 3 seconds
  static readonly MAX_RETRIES = 3;
  static readonly RESULT_OK = "OK";
  static readonly RESULT_ERROR = "ERROR";
  static readonly SSH_EXIT_CODE_CONNECTION_ERROR = 255;
}

/**
 * Global message index counter.
 */
let globalMessageIndex = 0;

/**
 * Gets and increments the global message index.
 */
export function getNextMessageIndex(): number {
  return globalMessageIndex++;
}

/**
 * Resets the global message index (mainly for testing).
 */
export function resetMessageIndex(): void {
  globalMessageIndex = 0;
}
