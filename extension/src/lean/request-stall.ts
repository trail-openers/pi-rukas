/**
 * The ONE reader of the silence a lean model request is allowed.
 *
 * The engine checks the cycle deadline only BETWEEN steps, so a request that hangs
 * INSIDE a step outlives it: an outer wall takes the cell, no handback is written and the
 * work is lost. The lever this file sizes is the child's own — a progress stream quiet for
 * this long, with no tool call in flight, is aborted through the same `AbortController`
 * the turns/tokens levers use, and the step reads it as the budget verdict those levers
 * already produce (`limit: "stall"` — see `step-budget.ts`).
 *
 * The window is derived, never written: the review reserve — what the handoff needs plus
 * what publish, ci and land need ({@link handoffAllowanceMs} +
 * {@link REVIEW_DEADLINE_RESERVE_MS}) — clamped to what the deadline still leaves outside
 * the handoff allowance. It does NOT read `ChildProgress.stall`'s 30/60-minute floors:
 * those size the shared silence watchdogs for a child with no deadline of its own, and a
 * lean cell is bounded by its own clock.
 *
 * Three arms leave it unarmed, and {@link requestStallInert} says which: no resolved
 * deadline (an absent deadline is never a reason to shrink work), dispatch caps off (the
 * master switch), or no room left outside the allowance — where the engine's own boundary
 * stop decides, so this lever must not arm a zero timer that kills instantly.
 */

import { capsEnabled } from "../spawn-child-bound.ts";
import { MINUTE_MS, handoffAllowanceMs } from "./deadline.ts";
import { REVIEW_DEADLINE_RESERVE_MS } from "./review-bound.ts";
import { leanRequestStallEnabled } from "./request-stall-switch.ts";

/** The whole reserve the window is derived from: handoff plus what the later steps need. */
function reserveMs(): number {
  return handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS;
}

/**
 * The silence a model request may sit out, in ms, or `undefined` when the lever is not
 * armed. `undefined` is inert, and the caller's trace says which arm it is on.
 */
export function requestStallWindowMs(
  deadlineMs: number | undefined,
  now: number,
): number | undefined {
  if (!leanRequestStallEnabled() || deadlineMs === undefined || !capsEnabled()) return undefined;
  const left = deadlineMs - now - handoffAllowanceMs();
  return left > 0 ? Math.min(reserveMs(), left) : undefined;
}

/**
 * What the arm says when it did NOT arm, or `undefined` when it did — the disclosure the
 * dispatching step traces, in `review-bound.ts`'s shape: a lever that bounded nothing
 * says so rather than reporting a bound that held.
 */
export function requestStallInert(
  deadlineMs: number | undefined,
  now: number,
): string | undefined {
  if (!leanRequestStallEnabled()) return undefined;
  if (requestStallWindowMs(deadlineMs, now) !== undefined) return undefined;
  const why =
    deadlineMs === undefined
      ? "no cycle deadline"
      : !capsEnabled()
        ? "PI_ENSEMBLE_DISPATCH_CAPS=0"
        : "no room outside the handoff allowance";
  return `request stall bound is inert: ${why}`;
}
