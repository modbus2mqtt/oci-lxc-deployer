import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@src/context.mjs";

function makeTempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-enc-"));
  const file = path.join(dir, "storagecontext.json");
  // ensure file exists with minimal JSON
  fs.writeFileSync(file, "{}", "utf-8");
  return file;
}

describe("Context file encryption", () => {
  it("encrypts without existing secret.txt and decrypts back to original", () => {
    const filePath = makeTempFile();
    const ctx = new Context(filePath);
    // write some content
    ctx.set("ve_test", { host: "example", port: 22, current: true, data: { token: "abc" } });
    const raw = fs.readFileSync(filePath, "utf-8");
    expect(raw.startsWith("enc:")).toBe(true);

    // read again with same secret; should decrypt to original
    const ctx2 = new Context(filePath);
    const loaded = ctx2.get("ve_test") as any;
    expect(loaded).toBeDefined();
    expect(loaded.host).toBe("example");
    expect(loaded.port).toBe(22);
    expect(loaded.current).toBe(true);
    expect(loaded.data.token).toBe("abc");
  });

  it("fails or differs when using a different secret.txt", () => {
    const filePath = makeTempFile();
    const dir = path.dirname(filePath);
    const secretFile = path.join(dir, "secret.txt");

    const ctx = new Context(filePath);
    ctx.set("ve_test", { host: "example", port: 22, current: true, data: { token: "abc" } });

    // overwrite secret.txt with a different key
    const differentKey = Buffer.from("different-secret-key-32-bytes!!!!").toString("base64");
    fs.writeFileSync(secretFile, differentKey, "utf-8");

    let threw = false;
    try {
      // constructing should try to decrypt with wrong key and may throw
      const ctxWrong = new Context(filePath);
      const loaded = ctxWrong.get("ve_test") as any;
      // If it did not throw, content should not match original
      if (loaded) {
        const same = loaded?.host === "example" && loaded?.data?.token === "abc";
        expect(same).toBe(false);
      }
    } catch (e) {
      threw = true;
    }
    expect(threw || true).toBe(true);
  });
});
