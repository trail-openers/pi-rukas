/**
 * request-stall-policy — the child-supervision side of #2644: when a hung model request may
 * be aborted, how long it may sit, and what an inert lever says.
 *
 * The engine checks the cycle deadline only BETWEEN steps, so a request hung INSIDE a step
 * outlives it. The lever is the child's own: a stream quiet this long with no tool call in
 * flight is aborted through the `AbortController` the turns/tokens levers use and reads back
 * as their `budget` verdict (`limit: "stall"`). The window is derived, never written — the
 * handoff allowance plus the review reserve, clamped to what the deadline leaves outside the
 * allowance; it does NOT read `ChildProgress.stall`'s 30/60-minute floors, which size
 * watchdogs for a child with no deadline of its own.
 *
 * Lives outside `src/lean/` because it is spawn policy, not engine state: it sizes the child's
 * abort, and takes the reserve it needs as a parameter so it never imports the lean tree.
 */

import { capsEnabled } from "./spawn-child-bound.ts";
import { handoffDispatchTimeoutMs } from "./work-driver-handoff.ts";

/** The four ceilings a budget verdict may name; `stall` measures silence, not spend. */
export type BudgetLimit = "minutes" | "turns" | "tokens" | "stall";

/** Reads THIS child's stream: how long quiet, and whether a tool call is running. */
export type StreamSilence = () => { sinceMs: number; toolInFlight: boolean };

/**
 * The ONE reader of the switch. Default ON: only the literal `"0"` takes it out, read at CALL
 * time — every other value (`""`, `"false"`, `"NO"`, a mangled `" 0 "`) keeps the shipped
 * behaviour, because a switch a shell accident could flip is a lost cell waiting to happen.
 */
export const leanRequestStallEnabled = (): boolean =>
  process.env.PI_ENSEMBLE_LEAN_REQUEST_STALL !== "0";

/** Why the lever armed nothing, or `undefined` when it did arm. */
function unarmed(deadlineMs: number | undefined, now: number) {
  if (!leanRequestStallEnabled()) return "switch" as const;
  if (deadlineMs === undefined) return "deadline" as const;
  if (!capsEnabled()) return "caps" as const;
  return deadlineMs - now - handoffDispatchTimeoutMs() > 0 ? undefined : ("room" as const);
}

/** The silence a model request may sit out, ms; `undefined` = inert, never a zero window. */
export function requestStallWindowMs(
  deadlineMs: number | undefined,
  now: number,
  reserveMs: number,
): number | undefined {
  if (unarmed(deadlineMs, now) !== undefined) return undefined;
  const allowance = handoffDispatchTimeoutMs();
  // `deadlineMs` is set here: `unarmed` refuses an unset deadline.
  return Math.min(allowance + reserveMs, deadlineMs! - now - allowance);
}

/**
 * The arm's disclosure when it armed nothing, in `review-bound.ts`'s shape: a lever that
 * bounded nothing says so rather than reporting a bound that held. `undefined` when it armed.
 */
export function requestStallUnarmed(
  deadlineMs: number | undefined,
  now: number,
): string | undefined {
  const causes = {
    caps: "PI_ENSEMBLE_DISPATCH_CAPS=0",
    deadline: "no cycle deadline",
    room: "no room outside the handoff allowance",
    switch: "PI_ENSEMBLE_LEAN_REQUEST_STALL=0",
  } as const;
  const reason = unarmed(deadlineMs, now);
  return reason === undefined ? undefined : `request stall bound is inert: ${causes[reason]}`;
}

/** Minutes of a stream's silence — the whole minutes a stall verdict prints. */
export function stallMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

/** The arms one dispatch is handed when the lever armed: the window in the whole minutes the
 *  verdict prints, and the reader of THIS child's stream. */
export interface StallOpts {
  windowMinutes: number;
  silence: StreamSilence;
}

/** Freeze the lever's arms, or arm nothing: no window, no reader, or a window of 0 or less,
 *  which is the engine's own boundary stop rather than a timer that kills the child the
 *  instant it starts. A lever with no reader measures nothing and must not claim a bound. */
export function stallLever(
  windowMs: number | undefined,
  silence: StreamSilence | undefined,
): StallOpts | undefined {
  return silence === undefined || windowMs === undefined || windowMs <= 0
    ? undefined
    : { windowMinutes: stallMinutes(windowMs), silence };
}
