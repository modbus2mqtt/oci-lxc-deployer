import type { IVeExecuteMessage } from "@shared/types.mjs";
import type { CliApiClient } from "./cli-api-client.mjs";
import { TimeoutError, ExecutionFailedError } from "./cli-types.mjs";

/**
 * Heartbeat cadence for "still polling" stderr messages when neither a new
 * IVeExecuteMessage nor a retry-failure has surfaced. Without this the
 * caller (user / livetest CLI / frontend wrapper) sees nothing while a
 * long step (docker pull, compose up, image build) runs silently — same
 * symptom as the Hub being unreachable, which is unhelpful for diagnosis.
 */
const HEARTBEAT_INTERVAL_MS = 30_000;

export interface ProgressOptions {
  quiet?: boolean;
  json?: boolean;
  verbose?: boolean;
  timeout: number;
  /** Filter polled messages to this restartKey only — required under
   *  parallel livetest runs, where multiple CLI processes share the same
   *  VE host but each speaks for a single deploy. Without it the server
   *  returns the union of all groups → each CLI sees other CLIs' errors.
   */
  restartKey?: string;
  /** Override heartbeat cadence (ms). Defaults to HEARTBEAT_INTERVAL_MS.
   *  Set to 0 to disable. Tests use a small value to exercise the path
   *  without faking timers. */
  heartbeatIntervalMs?: number;
}

export class CliProgress {
  private seenMessages = 0;
  private lastSeenIndex = -1;
  private totalSteps?: number;
  private startTime = Date.now();
  private lastMessageTime = Date.now();
  private lastHeartbeatTime = Date.now();

  constructor(
    private client: CliApiClient,
    private veContext: string,
    private options: ProgressOptions,
  ) {}

  async poll(): Promise<{ vmId?: number; success: boolean }> {
    const deadline = Date.now() + this.options.timeout * 1000;
    let retryCount = 0;
    // Default 3 retries (~15 s at 5 s/retry) for normal operations. The
    // self-upgrade-via-clone scenario destroys the deployer-CT mid-task
    // (boot+takeover gap can be 30-60+ s); the livetest runner sets
    // PROXVEX_CLI_MAX_RETRIES to ride out the gap and pick up the
    // adopted finished message on the new CT.
    const maxRetries = parseInt(process.env.PROXVEX_CLI_MAX_RETRIES ?? "3", 10);
    const heartbeatInterval = this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;

    while (Date.now() < deadline) {
      let messages: IVeExecuteMessage[];
      try {
        const since = this.lastSeenIndex >= 0 ? this.lastSeenIndex : undefined;
        const response = await this.client.getExecuteMessages(
          this.veContext,
          since,
          this.options.restartKey,
        );
        // Response is array of ISingleExecuteMessagesResponse
        const latest = response[response.length - 1];
        messages = latest?.messages ?? [];
        // Capture total steps from plannedSteps on first response
        if (this.totalSteps === undefined && latest?.plannedSteps) {
          this.totalSteps = latest.plannedSteps.length;
        }
        // Track highest seen index for delta-polling
        for (const msg of messages) {
          if (msg.index !== undefined && msg.index > this.lastSeenIndex) {
            this.lastSeenIndex = msg.index;
          }
        }
        retryCount = 0;
      } catch (err) {
        retryCount++;
        if (retryCount > maxRetries) throw err;
        // Surface the retry so the user knows we're not silently wedged.
        // Skipping json mode keeps the stdout stream pure for parsers; the
        // info still goes to stderr, which json-mode consumers don't read.
        const reason = err instanceof Error ? err.message : String(err);
        const elapsed = Math.round((Date.now() - this.startTime) / 1000);
        process.stderr.write(
          `[T+${elapsed}s] Hub not responding (${reason}); retry ${retryCount}/${maxRetries} in 5s\n`,
        );
        await sleep(5000);
        continue;
      }

      // With delta-polling, all returned messages are new
      for (const msg of messages) {
        this.renderMessage(msg, this.seenMessages);
        this.seenMessages++;
        this.lastMessageTime = Date.now();
        this.lastHeartbeatTime = Date.now();

        if (msg.finished) {
          const success = msg.exitCode === 0;
          if (!success) {
            throw new ExecutionFailedError(
              `Execution failed at step '${msg.command}' (exit code ${msg.exitCode})`,
            );
          }
          const elapsed = Math.round((Date.now() - this.startTime) / 1000);
          if (!this.options.quiet && !this.options.json) {
            process.stderr.write(
              `\nCompleted. VMID: ${msg.vmId ?? "N/A"}, Duration: ${elapsed}s\n`,
            );
            if (msg.completionInfo) {
              const info = msg.completionInfo;
              const line = "=".repeat(60);
              process.stderr.write(`\n${line}\n`);
              process.stderr.write(`  ${info.header}\n`);
              process.stderr.write(`${line}\n`);
              if (info.details) {
                for (const l of info.details.split("\n")) {
                  process.stderr.write(`  ${l}\n`);
                }
              }
              if (info.url) {
                process.stderr.write(`\n  URL: ${info.url}\n`);
              }
              process.stderr.write(`${line}\n`);
            }
          }
          const result: { vmId?: number; success: boolean } = { success: true };
          if (msg.vmId !== undefined) result.vmId = msg.vmId;
          return result;
        }
      }

      // Heartbeat when no message has surfaced for a while. Long steps
      // (docker pull, compose up, image build) can run silently between
      // start and finish — without this the user sees nothing and can't
      // tell apart "still working" from "hung/disconnected".
      const now = Date.now();
      if (
        heartbeatInterval > 0 &&
        now - this.lastHeartbeatTime > heartbeatInterval
      ) {
        const elapsedSinceStart = Math.round((now - this.startTime) / 1000);
        const silentFor = Math.round((now - this.lastMessageTime) / 1000);
        process.stderr.write(
          `[T+${elapsedSinceStart}s] Still polling, no progress for ${silentFor}s\n`,
        );
        this.lastHeartbeatTime = now;
      }

      await sleep(3000);
    }

    throw new TimeoutError(
      `Execution timed out after ${this.options.timeout}s`,
    );
  }

  private renderMessage(
    msg: IVeExecuteMessage,
    index: number,
  ): void {
    if (this.options.json) {
      process.stdout.write(JSON.stringify(msg) + "\n");
      return;
    }

    // Skip partial streaming messages
    if (msg.partial) return;

    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    const step = this.totalSteps ? `[${index + 1}/${this.totalSteps}]` : `[${index + 1}]`;
    const status =
      msg.exitCode === 0
        ? "OK"
        : msg.finished
          ? `FAILED (exit ${msg.exitCode})`
          : "...";
    const extra = msg.vmId ? ` (VMID: ${msg.vmId})` : "";
    const name = msg.command;

    process.stderr.write(
      `[${time}] ${step} ${name} ${"."
        .repeat(Math.max(1, 40 - name.length))} ${status}${extra}\n`,
    );

    // In quiet mode: show step headers (above) but skip logs — except on failure
    if (this.options.quiet) {
      if (msg.exitCode !== 0 && msg.stderr) {
        for (const line of msg.stderr.split("\n")) {
          if (line) process.stderr.write(`    ${line}\n`);
        }
      }
      return;
    }

    if ((this.options.verbose || msg.exitCode !== 0) && msg.stderr) {
      for (const line of msg.stderr.split("\n")) {
        if (line) process.stderr.write(`    ${line}\n`);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
