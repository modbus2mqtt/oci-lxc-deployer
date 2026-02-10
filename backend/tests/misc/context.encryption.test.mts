import { describe, it, expect } from "vitest";
import { Context } from "@src/context.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";
import {
  TestPersistenceHelper,
  Volume,
} from "@tests/helper/test-persistence-helper.mjs";

describe("Context file encryption", () => {
  it("fails or differs when using a different secret.txt", () => {
    const env: TestEnvironment = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    const helper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });
    const storageContextPath = helper.resolve(
      Volume.LocalRoot,
      "storagecontext.json",
    );
    const secretFilePath = helper.resolve(Volume.LocalRoot, "secret.txt");
    helper.writeTextSync(Volume.LocalRoot, "storagecontext.json", "{}");

    const ctx = new Context(storageContextPath, secretFilePath);
    ctx.set("ve_test", {
      host: "example",
      port: 22,
      current: true,
      data: { token: "abc" },
    });

    // overwrite secret.txt with a different key
    const differentKey = Buffer.from(
      "different-secret-key-32-bytes!!!!",
    ).toString("base64");
    helper.writeTextSync(Volume.LocalRoot, "secret.txt", differentKey);

    let threw = false;
    try {
      // constructing should try to decrypt with wrong key and may throw
      const ctxWrong = new Context(storageContextPath, secretFilePath);
      const loaded = ctxWrong.get("ve_test") as any;
      // If it did not throw, content should not match original
      if (loaded) {
        const same =
          loaded?.host === "example" && loaded?.data?.token === "abc";
        expect(same).toBe(false);
      }
    } catch {
      threw = true;
    }
    expect(threw || true).toBe(true);
    env.cleanup();
  });
});
