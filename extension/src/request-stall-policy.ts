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

import type { RunningState } from "./progress.ts";
import { capsEnabled } from "./spawn-child-bound.ts";
import { handoffDispatchTimeoutMs } from "./work-driver-handoff.ts";

/** The four ceilings a budget verdict may name; `stall` measures silence, not spend. */
export type BudgetLimit = "minutes" | "turns" | "tokens" | "stall";

/** The shape of the trio `lean/step-budget.ts` freezes for a breached ceiling; declared here so
 *  this module names the verdict it builds without importing the lean tree. */
export interface StallFired {
  limit: BudgetLimit;
  value: number;
  used: number;
}

/** #2644: what a step hands `armBudget` — the reserve the window is capped by, this child's stream
 *  reader, and the two times the window is measured between. `startedAt` is **when the step began**,
 *  read from the same durable step entry the step's own bound measures from (`stepBound`), not a
 *  fresh clock read at arm time: a step whose clock is scripted
 *  (`test-lean-review-bound-record.ts`) counts reads, and one extra slot would move its stop.
 *  Omit it and the lever is measured from now, which is what a caller outside a step gets. */
export interface StallArms {
  reserveMs: number;
  silence?: StreamSilence;
  deadlineMs?: number;
  startedAt?: number;
}

/** Reads THIS child's stream: how long quiet, and whether a tool call is running. */
export type StreamSilence = () => { sinceMs: number; toolInFlight: boolean };

/**
 * The ONE reader of the switch. Default ON: only the literal `"0"` takes it out, read at CALL
 * time — every other value (`""`, `"false"`, `"NO"`, a mangled `" 0 "`) keeps the shipped
 * behaviour, because a switch a shell accident could flip is a lost cell waiting to happen.
 */
export const leanRequestStallEnabled = (): boolean =>
  process.env.PI_ENSEMBLE_LEAN_REQUEST_STALL !== "0";

/** Why the lever armed nothing, or `undefined` when it did arm. `startedAt` is the instant the step
 *  read its own clock for the bound beside this lever — the disclosure's caller supplies it, so the
 *  lever's own arming never touches a clock. */
function unarmed(deadlineMs: number | undefined, startedAt: number) {
  if (!leanRequestStallEnabled()) return "switch" as const;
  if (deadlineMs === undefined) return "deadline" as const;
  if (!capsEnabled()) return "caps" as const;
  return deadlineMs - startedAt - handoffDispatchTimeoutMs() > 0 ? undefined : ("room" as const);
}

/** The silence a model request may sit out, ms; `undefined` = inert, never a zero window. */
export function requestStallWindowMs(
  deadlineMs: number | undefined,
  now: number,
  reserveMs: number,
): number | undefined {
  const allowance = handoffDispatchTimeoutMs();
  // Inert unless the deadline leaves room OUTSIDE the allowance, which stays startable.
  if (deadlineMs === undefined || !leanRequestStallEnabled() || !capsEnabled()) return undefined;
  if (deadlineMs - now <= allowance) return undefined;
  return Math.min(allowance + reserveMs, deadlineMs - now - allowance);
}

/**
 * The arm's disclosure when it armed nothing, in `review-bound.ts`'s shape: a lever that
 * bounded nothing says so rather than reporting a bound that held. `undefined` when it armed.
 */
export function requestStallUnarmed(
  deadlineMs: number | undefined,
  startedAt: number | undefined,
): string | undefined {
  if (deadlineMs === undefined || startedAt === undefined) return undefined;
  const causes = {
    caps: "PI_ENSEMBLE_DISPATCH_CAPS=0",
    deadline: "no cycle deadline",
    room: "no room outside the handoff allowance",
    switch: "PI_ENSEMBLE_LEAN_REQUEST_STALL=0",
  } as const;
  const reason = unarmed(deadlineMs, startedAt);
  return reason === undefined ? undefined : `request stall bound is inert: ${causes[reason]}`;
}

/**
 * The ONE composer of a step's inertness line: the minutes lever the runtime will not enforce under
 * `PI_ENSEMBLE_DISPATCH_CAPS=0` (`armChildBound` returns early there, where arming buys nothing) and
 * the stall lever that armed nothing, joined in that order. A silent half — `0` minutes, or `undefined`
 * stall wording — says nothing, and `undefined` for both is what tells the step to carry no `warning`
 * field at all rather than an empty one.
 */
export function inertWarning(minutes: number, stallInert: string | undefined) {
  return (
    [
      minutes > 0 && !capsEnabled()
        ? `${String(minutes)}-minute budget is inert: PI_ENSEMBLE_DISPATCH_CAPS=0`
        : "",
      stallInert ?? "",
    ]
      .filter(Boolean)
      .join("; ") || undefined
  );
}

/** Minutes of a stream's silence — the whole minutes a stall verdict prints. Rounds UP like its
 *  sibling `minutesUsed`: a verdict must never understate what the child waited, and rounding a
 *  13.8-minute hang down to 13 would print a silence shorter than the one that happened. */
export function stallMinutes(ms: number): number {
  return Math.max(1, Math.ceil(ms / 60_000));
}

/** The arms one dispatch is handed when the lever armed: the window in the whole minutes the
 *  verdict prints, the enforced threshold in ms, and the reader of THIS child's stream. */
export interface StallOpts {
  windowMinutes: number;
  /** The enforced threshold, ms: the derived window itself. `windowMinutes` is only ever what a
   *  verdict PRINTS (rounded up), so a clamped sub-minute window is enforced as what it is and
   *  not as a whole minute that can run past the time the deadline leaves. */
  windowMs: number;
  silence: StreamSilence;
  /** The caller's progress hook, which is what aborts the child it armed. The spawn composes it from
   *  its own stream (`stallLever` in `spawn-inactivity-poll.ts`); the step arms none, and a caller that
   *  forwards only the window needs nothing else. */
  check?: () => void;
}

/**
 * Freeze the lever's arms, or arm nothing: no window, no reader, or a window of 0 or less,
 * which is the engine's own boundary stop rather than a timer that kills the child the instant it
 * starts — a lever with no reader measures nothing and must not claim a bound. The enforced
 * threshold is the millisecond window; the frozen whole minutes are what a verdict prints and what
 * a sibling child's spawn is armed with, so the two cannot disagree. `undefined` is the whole of
 * "this step armed no stall lever", which is why no caller needs a second field saying the same
 * thing.
 *
 * The window is DERIVED HERE, at the freeze, from the arms the step supplied: the deadline it runs
 * against and the instant its own bound measures from, so the lever and the wall clock are measured
 * between the same two times and arming the stall reads no clock at all.
 */
export function stallLever(arms: StallArms | undefined): StallOpts | undefined {
  const startedAt = arms?.startedAt ?? Date.now();
  const windowMs = requestStallWindowMs(arms?.deadlineMs, startedAt, arms?.reserveMs ?? 0);
  return arms?.silence === undefined || windowMs === undefined || windowMs <= 0
    ? undefined
    : { windowMinutes: stallMinutes(windowMs), windowMs, silence: arms.silence };
}

/**
 * The stall arm of the progress hook, on the SAME tick the turns / tokens levers are checked:
 * a tool in flight is work, not silence, so it is never a stall (#951); a window of 0 or less is
 * the engine's boundary stop, never a timer that ends the child the instant it starts. The breach
 * is returned, never raised: the caller freezes it and fires the one abort.
 */
export function stallBreach(
  stall: StallOpts | undefined,
  s: Pick<RunningState, "turns" | "totalTokens">,
): StallFired | undefined {
  if (stall === undefined || s.turns !== 0 || s.totalTokens !== 0) return undefined;
  const quiet = stall.silence();
  return !quiet.toolInFlight && quiet.sinceMs >= stall.windowMs
    ? { limit: "stall", value: stall.windowMinutes, used: stallMinutes(quiet.sinceMs) }
    : undefined;
}
