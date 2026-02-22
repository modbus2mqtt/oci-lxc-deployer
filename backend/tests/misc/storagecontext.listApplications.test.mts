import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";

describe("StorageContext.listApplications", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: ["^applications/.*"],
    });
    env.initPersistence({ enableCache: false });
  });

  afterEach(() => {
    env.cleanup();
  });

  it("returns more than one application and first has name/description", () => {
    const pm = PersistenceManager.getInstance();
    const apps = pm.getApplicationService().listApplicationsForFrontend();

    expect(Array.isArray(apps)).toBe(true);
    expect(apps.length).toBeGreaterThan(1);

    const first = apps[0] as any;
    expect(typeof first?.name).toBe("string");
    expect((first?.name as string).length).toBeGreaterThan(0);
    expect(typeof first?.description).toBe("string");
    expect((first?.description as string).length).toBeGreaterThan(0);
  });
});
