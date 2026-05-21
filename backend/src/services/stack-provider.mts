import { IStack } from "../types.mjs";

/**
 * Stack provider interface.
 * Hub mode: local operations via ContextManager (LocalStackProvider).
 * Spoke mode: delegates to Hub API (RemoteStackProvider).
 *
 * All methods are async because RemoteStackProvider performs network I/O.
 * The earlier synchronous interface forced spawnSync("curl") which blocked
 * the Node event loop in Spoke mode and caused unrelated CLI connections
 * (POST /api/applications etc.) to drop with "fetch failed" during bursts
 * of stack-publish activity.
 */
export interface IStackProvider {
  listStacks(stacktype?: string): Promise<IStack[]>;
  getStack(id: string): Promise<IStack | null>;
  addStack(stack: IStack): Promise<string>;
  deleteStack(id: string): Promise<boolean>;
}
