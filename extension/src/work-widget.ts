/**
 * /work driver status footer (PR2 O2).
 *
 * Renders a single-line cursor in Pi's footer (via `ctx.ui.setStatus`)
 * showing the driver's current step + cap state. Distinct from the
 * dispatch deck above the editor, which shows individual spawned child
 * subagents; this footer shows the driver's step orchestration cursor.
 *
 * Pattern follows dispatch-deck.ts (session_start captures ctx; module-
 * level singleton owns the visible state). setStatus rather than
 * setWidget because:
 *   - the cursor is one line, not multi-row
 *   - setWidget already used by the deck for the spawn tree
 *   - footer is the right home for a single durable cursor
 *
 * Example renders:
 *   ▸ /work #553 · step 5/9 adversarial · 1m54s
 *   ▸ /work #553 · step 7/9 lens-fix · 3m12s · round 1/3 · cap 0m12s/1m30m
 *
 * Cleared (setStatus undefined) on terminal status (merged / handoff /
 * aborted) or session_shutdown — leaving stale cursors after a cycle
 * ends is worse than no cursor.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.ts";
import type { WorkState } from "./workflow-state.ts";

const STATUS_KEY = "ensemble:work";

/** Step ordinals — kept in sync with work-driver.ts STEP_ORDINAL. */
const STEP_ORDINAL: Record<string, { num: number; total: number }> = {
  explore: { num: 1, total: 9 },
  plan: { num: 2, total: 9 },
  branch: { num: 3, total: 9 },
  develop: { num: 4, total: 9 },
  adversarial: { num: 5, total: 9 },
  "commit-pr": { num: 6, total: 9 },
  "lens-review": { num: 7, total: 9 },
  "lens-fix": { num: 7, total: 9 },
  "step-back": { num: 7, total: 9 },
  ci: { num: 8, total: 9 },
  merged: { num: 9, total: 9 },
  handoff: { num: 9, total: 9 },
};

let activeCtx: ExtensionContext | undefined;
let lastIssue: number | undefined;
let stepStartedAt: number | undefined;
let tickHandle: ReturnType<typeof setInterval> | undefined;

function isQuiet(): boolean {
  return process.env.PI_ENSEMBLE_QUIET_STATUS === "1";
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, "0")}s`;
}

/** Capture the Pi extension context from session_start. */
export function attach(ctx: ExtensionContext): void {
  activeCtx = ctx;
}

/** Drop the context reference + clear the status. Called on session_shutdown. */
export function detach(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = undefined;
  }
  if (activeCtx) {
    try {
      activeCtx.ui.setStatus(STATUS_KEY, undefined);
    } catch {
      /* session going away anyway */
    }
  }
  activeCtx = undefined;
  lastIssue = undefined;
  stepStartedAt = undefined;
}

/**
 * Render the current driver status. Pure function for testability;
 * callers pass the `now` they want to compute elapsed against (defaults
 * to Date.now() for production usage).
 *
 * `stepStartedAtMs` is the epoch ms when the current step's body
 * STARTED — distinct from state.startedAt (cycle start) and state.updatedAt
 * (last state-file write). The driver owns this; the widget receives it
 * via `update()` each step boundary.
 */
export function renderStatus(
  state: WorkState,
  stepStartedAtMs: number,
  now: number = Date.now(),
): string {
  const ps = state.pipelineState;
  const ord = STEP_ORDINAL[ps.currentStep] ?? { num: 0, total: 9 };
  const stepElapsed = fmtElapsed(Math.max(0, now - stepStartedAtMs));
  const parts: string[] = [
    `▸ /work #${state.issue}`,
    `step ${ord.num}/${ord.total} ${ps.currentStep}`,
    stepElapsed,
  ];
  // Append cap state when relevant (review-fix loop active or CI retries used).
  if (ps.reviewRound > 0) {
    parts.push(`round ${ps.reviewRound}/3`);
    if (ps.reviewCapStartedAt) {
      const capElapsed = fmtElapsed(now - ps.reviewCapStartedAt);
      parts.push(`cap ${capElapsed}/90m`);
    }
  }
  if ((ps.ciRetryCount ?? 0) > 0) {
    parts.push(`ci-retry ${ps.ciRetryCount}/2`);
  }
  return parts.join(" · ");
}

/**
 * Update the status line. Called by the work-driver on every step
 * transition. `stepStartedAtMs` should be the moment the current step's
 * body began (so elapsed reflects current-step time, not cycle time).
 *
 * Schedules a 1Hz ticker to keep the elapsed counter live between
 * transitions — same shape as dispatch-deck's tick loop. The ticker
 * stops when the cycle terminates.
 */
export function update(state: WorkState, stepStartedAtMs: number): void {
  if (isQuiet()) return;
  lastIssue = state.issue;
  stepStartedAt = stepStartedAtMs;
  if (!activeCtx) return;
  // Render once immediately, then start the ticker so elapsed advances
  // even when no transitions fire (e.g., a 5-min adversarial loop where
  // the widget would otherwise be stale until next step).
  writeStatus(state);
  startTickerIfNeeded(state);
}

function writeStatus(state: WorkState): void {
  if (!activeCtx || stepStartedAt === undefined) return;
  try {
    activeCtx.ui.setStatus(STATUS_KEY, renderStatus(state, stepStartedAt));
  } catch (err) {
    trace(`work-widget: setStatus failed: ${(err as Error).message}`);
  }
}

let lastState: WorkState | undefined;
function startTickerIfNeeded(state: WorkState): void {
  lastState = state;
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    if (!lastState) return;
    writeStatus(lastState);
  }, 1000);
  // Don't keep the process alive just for the ticker.
  if (typeof (tickHandle as { unref?: () => void }).unref === "function") {
    (tickHandle as { unref: () => void }).unref();
  }
}

/** Clear the status line. Called by work-driver on terminal status (merged/handoff/aborted). */
export function clear(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = undefined;
  }
  lastState = undefined;
  stepStartedAt = undefined;
  if (!activeCtx) return;
  try {
    activeCtx.ui.setStatus(STATUS_KEY, undefined);
  } catch (err) {
    trace(`work-widget: clear failed: ${(err as Error).message}`);
  }
}

/** Test-only — expose attached state for assertions. */
export function snapshot(): { issue: number | undefined; stepStartedAt: number | undefined } {
  return { issue: lastIssue, stepStartedAt };
}
