import { existsSync, readFileSync, writeFileSync } from "fs";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

export class Context {
  private context: Record<string, any> = {};
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf-8");
      const jsonText = raw.startsWith("enc:") ? this.decrypt(raw) : raw;
      this.context = JSON.parse(jsonText);
    }
  }
  set(key: string, value: any): void {
    this.context[key] = value;
    this.writeAll();
  }

  get<T = any>(key: string): T | undefined {
    return this.context[key];
  }

  has(key: string): boolean {
    return key in this.context;
  }

  remove(key: string): void {
    delete this.context[key];
    // Persist removal to disk to ensure deletions survive reloads
    this.writeAll();
  }

  clear(): void {
    this.context = {};
    this.writeAll();
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
      // Do not persist here; only populate in-memory cache
      this.context[key] = instance;
    }
  }

  // ===== Encryption / Decryption helpers (used by StorageContext and consumers) =====
  private getSecretFilePath(): string {
    const baseDir = path.dirname(this.filePath);
    return path.join(baseDir, "secret.txt");
  }

  private readOrCreateSecret(): Buffer {
    const secretPath = this.getSecretFilePath();
    try {
      if (existsSync(secretPath)) {
        const raw = readFileSync(secretPath, "utf-8").trim();
        if (raw) {
          try {
            return Buffer.from(raw, "base64");
          } catch {}
        }
      }
    } catch {}
    const key = randomBytes(32);
    try {
      // ensure base dir exists (dirname of filePath already exists by construction)
      writeFileSync(secretPath, key.toString("base64"), "utf-8");
    } catch {}
    return key;
  }

  encrypt(plainText: string): string {
    const key = this.readOrCreateSecret();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, tag, enc]).toString("base64");
    return `enc:${packed}`;
  }

  decrypt(encText: string): string {
    const pref = encText.startsWith("enc:") ? encText.slice(4) : encText;
    const buf = Buffer.from(pref, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const key = this.readOrCreateSecret();
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString("utf8");
  }

  isEncrypted(val: unknown): boolean {
    return typeof val === "string" && val.startsWith("enc:");
  }

  decryptIfEncrypted<T = unknown>(val: T): T | string {
    if (typeof val === "string" && this.isEncrypted(val)) {
      return this.decrypt(val);
    }
    return val;
  }

  private sanitizeForWrite(obj: any): any {
    // No per-field encryption anymore; entire file is encrypted by writeAll
    const transform = (val: any): any => {
      if (Array.isArray(val)) return val.map(transform);
      if (val && typeof val === "object") {
        const out: any = {};
        for (const [k, v] of Object.entries(val)) out[k] = transform(v);
        return out;
      }
      return val;
    };
    return transform(obj);
  }

  private sanitizeForRead(obj: any): any {
    // No per-field decryption anymore; entire file is decrypted in constructor
    const transform = (val: any): any => {
      if (Array.isArray(val)) return val.map(transform);
      if (val && typeof val === "object") {
        const out: any = {};
        for (const [k, v] of Object.entries(val)) out[k] = transform(v);
        return out;
      }
      return val;
    };
    return transform(obj);
  }

  private writeAll(): void {
    try {
      const json = JSON.stringify(this.context, null, 2);
      const enc = this.encrypt(json);
      writeFileSync(this.filePath, enc, "utf-8");
    } catch {}
  }
}
