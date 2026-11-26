/**
 * The ONE reader of the silence a lean model request is allowed.
 *
 * The engine checks the cycle deadline only BETWEEN steps, so a request hung INSIDE a step
 * outlives it. The lever is the child's own: a stream quiet this long with no tool call in
 * flight is aborted through the `AbortController` the turns/tokens levers use and reads back
 * as their `budget` verdict (`limit: "stall"`). The window is derived, never written —
 * {@link handoffAllowanceMs} + {@link REVIEW_DEADLINE_RESERVE_MS}, clamped to what the
 * deadline leaves outside the allowance; it does NOT read `ChildProgress.stall`'s 30/60-minute
 * floors, which size watchdogs for a child with no deadline of its own. {@link
 * requestStallUnarmed} names the arm that left it unarmed: no resolved deadline, dispatch caps
 * off, or no room outside the allowance — where the between-steps stop already decides, so a
 * zero timer that would kill the child instantly must never arm.
 */

import { capsEnabled } from "../spawn-child-bound.ts";
import type { LeanRun } from "./state.ts";
import { handoffAllowanceMs } from "./deadline.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "./review-bound.ts";
import type { StallArms } from "./step-budget.ts";

/**
 * The ONE reader of the switch. Default ON: only the literal `"0"` takes it out, read at CALL
 * time — every other value (`""`, `"false"`, `"NO"`, a mangled `" 0 "`) keeps the shipped
 * behaviour, because a switch a shell accident could flip is a lost cell waiting to happen.
 */
export const leanRequestStallEnabled = (): boolean =>
  process.env.PI_ENSEMBLE_LEAN_REQUEST_STALL !== "0";

/** Why the lever armed nothing, or `undefined` when it did arm. */
function unarmed(
  deadlineMs: number | undefined,
  now: number,
): "switch" | "deadline" | "caps" | "room" | undefined {
  if (!leanRequestStallEnabled()) return "switch";
  if (deadlineMs === undefined) return "deadline";
  if (!capsEnabled()) return "caps";
  return deadlineMs - now - handoffAllowanceMs() > 0 ? undefined : "room";
}

/** The silence a model request may sit out, ms; `undefined` = inert, never a zero window. */
export function requestStallWindowMs(
  deadlineMs: number | undefined,
  now: number,
): number | undefined {
  if (unarmed(deadlineMs, now) !== undefined) return undefined;
  const left = deadlineMs! - now - handoffAllowanceMs();
  return Math.min(handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS, left);
}

/**
 * The arm's disclosure when it armed nothing, in `review-bound.ts`'s shape: a lever that
 * bounded nothing says so rather than reporting a bound that held. `undefined` when it armed.
 */
export function requestStallUnarmed(
  deadlineMs: number | undefined,
  now: number,
): string | undefined {
  switch (unarmed(deadlineMs, now)) {
    case undefined:
      return undefined;
    case "caps":
      return "request stall bound is inert: PI_ENSEMBLE_DISPATCH_CAPS=0";
    case "deadline":
      return "request stall bound is inert: no cycle deadline";
    case "room":
      return "request stall bound is inert: no room outside the handoff allowance";
    default:
      return "request stall bound is inert: PI_ENSEMBLE_LEAN_REQUEST_STALL=0";
  }
}

/** The arms one step passes `armBudget`, derived from the run's own clock. A step has no
 *  stream to read — the child's spawn supplies its stamp and hands the breach back through the
 *  arm's `onProgress` — so the reader here measures nothing. */
export function stallArms(ctx: { run: LeanRun; now: () => number }): StallArms {
  const now = ctx.now();
  return {
    windowMs: requestStallWindowMs(ctx.run.deadlineMs, now),
    silence: () => ({ sinceMs: 0, toolInFlight: false }),
    ...(ctx.run.deadlineMs === undefined ? {} : { deadlineMs: ctx.run.deadlineMs }),
    now,
  };
}
