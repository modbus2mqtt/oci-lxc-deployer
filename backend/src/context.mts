import { existsSync, readFileSync, writeFileSync } from "fs";

export class Context {
  private context: Record<string, any> = {};
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    if (existsSync(filePath)) {
      this.context = JSON.parse(readFileSync(filePath, "utf-8"));
    }
  }
  set(key: string, value: any): void {
    this.context[key] = value;
    writeFileSync(
      this.filePath,
      JSON.stringify(this.context, null, 2),
      "utf-8",
    );
  }

  get<T = any>(key: string): T | undefined {
    return this.context[key];
  }

  has(key: string): boolean {
    return key in this.context;
  }

  remove(key: string): void {
    delete this.context[key];
  }

  clear(): void {
    this.context = {};
  }

  keys(): string[] {
    return Object.keys(this.context);
  }
  /**
   * Read all context entries with the given prefix and instantiate them with the given class
   * @param ctxPrefix
   * @param Clazz
   */
  protected loadContexts<C extends new (data: any) => any>(
    ctxPrefix: string,
    Clazz: C,
  ) {
    const saved: Record<string, any> = structuredClone(this.context);
    for (const [key, value] of Object.entries(saved)) {
      if (!key.startsWith(ctxPrefix + "_")) {
        continue;
      }
      const instance = new Clazz(value);
      this.set(key, instance);
    }
  }
}
