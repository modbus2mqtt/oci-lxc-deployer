import { describe, it, expect, beforeEach, vi } from "vitest";
import { CliProgress } from "../src/cli-progress.mjs";
import { TimeoutError, ExecutionFailedError } from "../src/cli-types.mjs";
import type { CliApiClient } from "../src/cli-api-client.mjs";

describe("CliProgress", () => {
  let mockClient: {
    getExecuteMessages: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockClient = {
      getExecuteMessages: vi.fn(),
    };
    // Suppress stderr output during tests
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  function createProgress(
    options: { quiet?: boolean; json?: boolean; timeout?: number } = {},
  ): CliProgress {
    return new CliProgress(
      mockClient as unknown as CliApiClient,
      "ve_pve1",
      { quiet: false, json: false, timeout: options.timeout ?? 5, ...options },
    );
  }

  it("should return success when execution finishes with exit code 0", async () => {
    mockClient.getExecuteMessages.mockResolvedValueOnce([
      {
        messages: [
          { command: "step1", commandtext: "Step 1", exitCode: 0, finished: true, vmId: 105 },
        ],
      },
    ]);

    const progress = createProgress();
    const result = await progress.poll();
    expect(result.success).toBe(true);
    expect(result.vmId).toBe(105);
  });

  it("should throw ExecutionFailedError on non-zero exit code", async () => {
    mockClient.getExecuteMessages.mockResolvedValueOnce([
      {
        messages: [
          { command: "step1", commandtext: "Step 1", exitCode: 1, finished: true },
        ],
      },
    ]);

    const progress = createProgress();
    await expect(progress.poll()).rejects.toThrow(ExecutionFailedError);
  });

  it("should throw TimeoutError when deadline exceeded", async () => {
    // Always return empty messages — never finish
    mockClient.getExecuteMessages.mockResolvedValue([
      { messages: [] },
    ]);

    const progress = createProgress({ timeout: 0 });
    await expect(progress.poll()).rejects.toThrow(TimeoutError);
  });

  it("should output JSON lines in json mode", async () => {
    const msg = { command: "step1", commandtext: "Step 1", exitCode: 0, finished: true, vmId: 42 };
    mockClient.getExecuteMessages.mockResolvedValueOnce([
      { messages: [msg] },
    ]);

    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const progress = createProgress({ json: true });
    await progress.poll();

    const jsonOutput = stdoutWrite.mock.calls.find(
      (call) => typeof call[0] === "string" && call[0].includes("step1"),
    );
    expect(jsonOutput).toBeDefined();
    const parsed = JSON.parse(jsonOutput![0] as string);
    expect(parsed.command).toBe("step1");
  });

  it("should suppress step output in quiet mode", async () => {
    mockClient.getExecuteMessages.mockResolvedValueOnce([
      {
        messages: [
          { command: "step1", commandtext: "Step 1", exitCode: 0, finished: true, vmId: 1 },
        ],
      },
    ]);

    const stderrWrite = vi.mocked(process.stderr.write);
    stderrWrite.mockClear();

    const progress = createProgress({ quiet: true });
    await progress.poll();

    // In quiet mode, no step messages or "Completed" should be written to stderr
    const allStderrOutput = stderrWrite.mock.calls
      .map((call) => String(call[0]))
      .join("");
    expect(allStderrOutput).not.toContain("Step 1");
    expect(allStderrOutput).not.toContain("Completed");
  });

  it("should retry on fetch failure up to maxRetries", async () => {
    mockClient.getExecuteMessages
      .mockRejectedValueOnce(new Error("network error"))
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce([
        {
          messages: [
            { command: "step1", commandtext: "Step 1", exitCode: 0, finished: true, vmId: 1 },
          ],
        },
      ]);

    const progress = createProgress({ timeout: 30 });
    const result = await progress.poll();
    expect(result.success).toBe(true);
    expect(mockClient.getExecuteMessages).toHaveBeenCalledTimes(3);
  });

  it("should surface fetch failures on stderr including reason and retry count", async () => {
    mockClient.getExecuteMessages
      .mockRejectedValueOnce(new Error("ECONNREFUSED 192.168.4.24:1080"))
      .mockResolvedValueOnce([
        {
          messages: [
            { command: "step1", commandtext: "Step 1", exitCode: 0, finished: true, vmId: 1 },
          ],
        },
      ]);

    const stderrWrite = vi.mocked(process.stderr.write);
    stderrWrite.mockClear();

    const progress = createProgress({ timeout: 30 });
    await progress.poll();

    const stderrOutput = stderrWrite.mock.calls
      .map((call) => String(call[0]))
      .join("");
    expect(stderrOutput).toContain("Hub not responding");
    expect(stderrOutput).toContain("ECONNREFUSED");
    expect(stderrOutput).toMatch(/retry 1\/\d+/);
  });

  it("should emit a heartbeat after the configured silent interval", async () => {
    // Resolve every poll with an empty message list — the inner loop
    // never finds a `finished: true` message, so heartbeat path fires
    // until the test-level timeout (5 s) trips and TimeoutError throws.
    mockClient.getExecuteMessages.mockResolvedValue([{ messages: [] }]);

    const stderrWrite = vi.mocked(process.stderr.write);
    stderrWrite.mockClear();

    const progress = new CliProgress(
      mockClient as unknown as CliApiClient,
      "ve_pve1",
      { quiet: false, json: false, timeout: 5, heartbeatIntervalMs: 1 },
    );

    await expect(progress.poll()).rejects.toThrow(TimeoutError);

    const stderrOutput = stderrWrite.mock.calls
      .map((call) => String(call[0]))
      .join("");
    expect(stderrOutput).toContain("Still polling");
    expect(stderrOutput).toMatch(/no progress for \d+s/);
  });
});
