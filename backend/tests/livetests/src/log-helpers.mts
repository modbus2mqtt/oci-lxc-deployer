/**
 * Shared logging helpers for the live integration test runner.
 * Provides colored console output for test steps and results.
 *
 * Per-scenario tap: when a log call happens inside a `scenarioLogContext`
 * (entered via AsyncLocalStorage in scenario-executor's runStep), the event
 * is *also* pushed into the context's `buffer`. The runner periodically
 * POSTs that buffer to the backend's
 * `POST /api/ve/debug/:restartKey/external-events` endpoint so it lands in
 * the unified per-scenario debug bundle timeline (see
 * WebAppDebugCollector.attachRunnerEvent). Without the context the existing
 * console-only behaviour is unchanged.
 */

import { AsyncLocalStorage } from "node:async_hooks";

// ── Colors ──

export const RED = "\x1b[0;31m";
export const GREEN = "\x1b[0;32m";
export const YELLOW = "\x1b[1;33m";
export const BLUE = "\x1b[0;34m";
export const NC = "\x1b[0m";

export type RunnerLogLevel = "info" | "ok" | "warn" | "fail" | "step" | "debug";

export interface RunnerEvent {
  ts: number;
  level: RunnerLogLevel;
  msg: string;
}

export interface ScenarioLogContext {
  scenarioId: string;
  /** Set once the deploy's restartKey is known (after `runCli` returns). */
  restartKey?: string;
  /** Append-only buffer of runner events for the current scenario. */
  buffer: RunnerEvent[];
}

export const scenarioLogContext = new AsyncLocalStorage<ScenarioLogContext>();

function tap(level: RunnerLogLevel, msg: string): void {
  const ctx = scenarioLogContext.getStore();
  if (!ctx) return;
  ctx.buffer.push({ ts: Date.now(), level, msg });
}

export function logOk(msg: string) { tap("ok", msg); console.log(`${GREEN}✓${NC} ${msg}`); }
export function logFail(msg: string) { tap("fail", msg); console.log(`${RED}✗${NC} ${msg}`); }
export function logWarn(msg: string) { tap("warn", msg); console.log(`${YELLOW}!${NC} ${msg}`); }
export function logInfo(msg: string) { tap("info", msg); console.log(`→ ${msg}`); }
export function logStep(step: string, desc: string) {
  tap("step", `${step}: ${desc}`);
  console.log(`\n${BLUE}── ${step}: ${desc} ──${NC}`);
}
