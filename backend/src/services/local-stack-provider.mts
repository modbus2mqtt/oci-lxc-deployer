import { IStack } from "../types.mjs";
import { ContextManager } from "../context-manager.mjs";
import { IStackProvider } from "./stack-provider.mjs";

/**
 * Local stack provider: delegates to ContextManager stack methods.
 * Used as the Hub/Standalone stack provider. The wrapper methods are
 * `async` only to satisfy the IStackProvider Promise contract; the
 * underlying ContextManager ops are pure in-memory and synchronous.
 */
export class LocalStackProvider implements IStackProvider {
  constructor(private contextManager: ContextManager) {}

  async listStacks(stacktype?: string): Promise<IStack[]> {
    return this.contextManager.listStacks(stacktype);
  }

  async getStack(id: string): Promise<IStack | null> {
    return this.contextManager.getStack(id);
  }

  async addStack(stack: IStack): Promise<string> {
    return this.contextManager.addStack(stack);
  }

  async deleteStack(id: string): Promise<boolean> {
    return this.contextManager.deleteStack(id);
  }
}
