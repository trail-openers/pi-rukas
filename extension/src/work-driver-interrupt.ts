/**
 * work-driver-interrupt — the driver's own answer to an interrupt (S4a, #1162;
 * headless S4, #1024).
 *
 * The runner's SIGTERM / SIGINT handler aborts the cycle's `signal`. The driver
 * checks it at each step boundary and records the interrupt itself, through
 * `persistCycle`, so the in-memory snapshot it keeps is the one that lands on
 * disk: there is no storage-layer override that could rewrite a later persist.
 *
 * The interrupt applies only while the cycle is `running`. A terminal status is
 * never rewritten, and an interrupt is recorded once per run (the signal is
 * one-shot).
 */

import type { CycleContext, DriverContext } from "./work-driver-context.ts";
import { persistCycle } from "./workflow-state.ts";
import { type WorkState, appendEvent } from "./workflow-state.ts";

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
  if (!signal?.aborted || state.pipelineState.status !== "running") return state;
  const reason = typeof signal.reason === "string" ? signal.reason : "signal";
  const next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, status: "interrupted" } },
    { kind: "interrupted", at: Date.now(), reason },
  );
  await persistCycle(ctx, next);
  return next;
}
