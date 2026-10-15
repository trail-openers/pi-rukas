/**
 * work-driver-interrupt — the driver's own answer to an interrupt (S4a, #1162;
 * headless S4, #1024).
 *
 * The runner's SIGTERM / SIGINT handler aborts the cycle's `signal`. The driver
 * checks it at each step boundary and records the interrupt itself, through
 * `persistCycle`, so the in-memory snapshot it keeps is the one that lands on
 * disk: there is no storage-layer override that could rewrite a later persist.
 *
 * The interrupt is the pure transition `applyInterrupt` (workflow-state.ts): it
 * applies only while the cycle is `running`, so a terminal status is never
 * rewritten, and an interrupt is recorded once per run.
 *
 * Events are never dropped. A step that was in flight when the signal fired
 * keeps every event it appended (they happened); the driver then stops without
 * routing that step's outcome.
 */

import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import {
  type WorkState,
  appendEvent,
  applyInterrupt,
  interruptReasonOf,
  persistCycle,
} from "./workflow-state.ts";

/**
 * If the cycle's signal has fired and the cycle is still running, record the
 * interrupt in `state`, persist it, and return the interrupted state. Otherwise
 * return `state` unchanged (no write).
 */
export async function interruptIfRequested(
  ctx: CycleContext,
  state: WorkState,
): Promise<WorkState> {
  const signal = ctx.signal;
  if (signal?.aborted !== true) return state;
  const next = applyInterrupt(state, interruptReasonOf(signal), Date.now());
  if (next === state) return state;
  await persistCycle(ctx, next);
  return next;
}

/**
 * A step threw. Traced and recorded as a plumb note BEFORE the caller decides
 * how to route the crash — an interrupt (signal fired), a direct abort
 * (handoff crash, DriverNotImplemented), or the handoff-cap route (#1263,
 * where the caller appends a `driver-crash:<step>` cap and `continue`s to
 * `handoff` rather than returning). So a crash that coincides with a signal is
 * not lost. The returned state carries the note; the caller persists it.
 */
export function recordStepCrash(
  state: WorkState,
  step: WorkState["pipelineState"]["currentStep"],
  err: unknown,
): WorkState {
  const message = err instanceof Error ? `${err.message}\n${err.stack ?? ""}`.trim() : String(err);
  trace(`work-driver: step "${step}" threw: ${message}`);
  return appendEvent(state, {
    kind: "plumb-report",
    at: Date.now(),
    step,
    role: "driver",
    body: `step "${step}" threw: ${message}`,
  });
}
