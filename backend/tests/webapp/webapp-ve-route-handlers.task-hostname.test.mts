import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebAppVeRouteHandlers } from "@src/webapp/webapp-ve-route-handlers.mjs";
import { IVEContext } from "@src/backend-types.mjs";
import { IPostVeConfigurationBody } from "@src/types.mjs";
import * as containerListService from "@src/services/container-list-service.mjs";
import {
  createTestEnvironment,
  type TestEnvironment,
} from "../helper/test-environment.mjs";

vi.mock("@src/services/container-list-service.mjs", () => ({
  listManagedContainers: vi.fn(),
}));

const mockListManagedContainers = vi.mocked(
  containerListService.listManagedContainers,
);

/**
 * Unit tests for the private hostname resolver that feeds the per-hostname
 * concurrency guard. The guard rejects a second task on a hostname already
 * being mutated, so getting the hostname right for every task shape
 * (install carries it directly; upgrade/reconfigure carry only
 * previous_vm_id) is what these tests pin down.
 */
describe("WebAppVeRouteHandlers.resolveTaskHostname", () => {
  let env: TestEnvironment;
  let handler: WebAppVeRouteHandlers;
  const mockVeContext: IVEContext = { host: "pve1.cluster", port: 22 } as IVEContext;

  beforeEach(() => {
    vi.resetAllMocks();
    env = createTestEnvironment(import.meta.url, { jsonIncludePatterns: [] });
    env.initPersistence({ enableCache: false });
    handler = new WebAppVeRouteHandlers(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  });

  afterEach(() => {
    env.cleanup();
  });

  function resolve(body: IPostVeConfigurationBody): Promise<string | undefined> {
    return (handler as unknown as {
      resolveTaskHostname: (
        b: IPostVeConfigurationBody,
        v: IVEContext,
      ) => Promise<string | undefined>;
    }).resolveTaskHostname(body, mockVeContext);
  }

  it("uses the hostname param directly for installs (no container list fetch)", async () => {
    const result = await resolve({
      task: "installation",
      params: [{ name: "hostname", value: "freshhost" }],
    } as IPostVeConfigurationBody);
    expect(result).toBe("freshhost");
    expect(mockListManagedContainers).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace on a direct hostname", async () => {
    const result = await resolve({
      task: "installation",
      params: [{ name: "hostname", value: "  spaced  " }],
    } as IPostVeConfigurationBody);
    expect(result).toBe("spaced");
  });

  it("resolves the source hostname from previous_vm_id for upgrade/reconfigure", async () => {
    mockListManagedContainers.mockResolvedValueOnce([
      { vm_id: 503, hostname: "proxvex" },
      { vm_id: 510, hostname: "zitadel" },
    ] as never);

    const result = await resolve({
      task: "upgrade",
      params: [{ name: "previous_vm_id", value: 503 }],
    } as IPostVeConfigurationBody);

    expect(result).toBe("proxvex");
    expect(mockListManagedContainers).toHaveBeenCalledTimes(1);
  });

  it("matches previous_vm_id loosely (string vs number)", async () => {
    mockListManagedContainers.mockResolvedValueOnce([
      { vm_id: 508, hostname: "proxvex" },
    ] as never);

    const result = await resolve({
      task: "reconfigure",
      params: [{ name: "previous_vm_id", value: "508" }],
    } as IPostVeConfigurationBody);

    expect(result).toBe("proxvex");
  });

  it("returns undefined (fail-open) when no hostname can be derived", async () => {
    const result = await resolve({
      task: "installation",
      params: [{ name: "static_ip", value: "192.168.4.9/24" }],
    } as IPostVeConfigurationBody);
    expect(result).toBeUndefined();
    expect(mockListManagedContainers).not.toHaveBeenCalled();
  });

  it("returns undefined when previous_vm_id matches no managed container", async () => {
    mockListManagedContainers.mockResolvedValueOnce([
      { vm_id: 1, hostname: "other" },
    ] as never);

    const result = await resolve({
      task: "upgrade",
      params: [{ name: "previous_vm_id", value: 999 }],
    } as IPostVeConfigurationBody);
    expect(result).toBeUndefined();
  });

  it("fails open (undefined) when the container list cannot be fetched", async () => {
    mockListManagedContainers.mockRejectedValueOnce(new Error("ssh: no route to host"));

    const result = await resolve({
      task: "upgrade",
      params: [{ name: "previous_vm_id", value: 503 }],
    } as IPostVeConfigurationBody);
    expect(result).toBeUndefined();
  });
});
