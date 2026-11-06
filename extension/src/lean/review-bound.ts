/**
 * lean/review-bound — the `review` STEP's own wall clock, and what a stop says.
 *
 * `budgets.review.minutes` was armed on every child through `armBudget` and bounded
 * none of them as a step: the step buys its children serially, each inside its own
 * per-child bound, so the total was unbounded and a field run spent 69 of its ~89
 * minutes here and starved publish, ci and land. The child levers are unchanged.
 *
 * Two levers and an out: the **step budget** (`budgets.review.minutes`, read
 * verbatim — no new knob); the **deadline reserve**, {@link handoffAllowanceMs}
 * PLUS {@link REVIEW_DEADLINE_RESERVE_MS} for publish, ci and land, which the
 * engine's BETWEEN-steps deadline check cannot protect because it never looks while
 * a step runs; and the **caps master switch**, under which neither lever stops
 * anything and `StepBound.inert` says so rather than reporting a disabled bound.
 *
 * **The clock is the durable record, not the closure:** a resumed attempt re-enters
 * with its earlier review entries in the log, so the spend comes off this attempt's
 * `startedAt`; a fresh `now()` would hand it a whole budget again.
 *
 * **A stop is not one verdict** — nothing reviewed, a complete unblocked first
 * round, or a pushed fix route three different ways, and `review.ts` owns those
 * readings. This module owns the clock, the shape of a stop, and its disclosure.
 */

import { neutraliseEvidence } from "../comment-evidence.ts";
import { capsEnabled } from "../spawn-child-bound.ts";
import { MINUTE_MS, handoffAllowanceMs } from "./deadline.ts";
import type { HandlerCtx } from "./engine.ts";
import type { ReviewWave } from "./review-args.ts";
import type { ReviewBoundRecord, Step } from "./state.ts";

/**
 * The time publish, ci and land still need when the review step is asked to stop,
 * ON TOP of {@link handoffAllowanceMs}. Added to, never replacing: the engine's own
 * deadline checks keep comparing against the allowance alone.
 */
export const REVIEW_DEADLINE_RESERVE_MS = 15 * 60_000;

/** Why the step stopped dispatching: its own budget, or the caller's deadline. */
export type StepBoundLimit = "step-minutes" | "cycle-deadline";

/**
 * What the step's clock says about the instant a child is about to be paid for.
 * `live` past a lever means dispatch nothing further; `inert` means the caps master
 * switch is off, so the step stops nothing and says so with the same disclosure
 * `armBudget`'s `warning` carries for a child. A step stop's `reason` is not
 * `budgetSentence`'s wording — that names a CHILD's lever, and a step-total stop is
 * a different clock — which keeps "one child ran long" and "the step ran out" two
 * readable facts.
 */
export interface StepBound {
  live: boolean;
  inert: boolean;
  /** Which lever closed — present exactly when `live` is true. */
  limit?: StepBoundLimit;
  /** Minutes spent, the number the disclosure prints. */
  usedMinutes: number;
  /** The budget the spend is measured against, in minutes. */
  budgetMinutes: number;
  /** Ms left before the deadline reserve runs out; absent with no deadline. */
  deadlineLeftMs?: number;
}

/** The step-bound verdict: what {@link reviewBoundRecord} carries. */
export interface StepStop {
  limit: StepBoundLimit;
  /** The lever's own number: the budget's minutes, or the reserve's. */
  value: number;
  used: number;
  reason: string;
}

/// The newest review entry is this attempt's own, so a handler driven outside the
/// engine still measures from the start the durable log recorded.
function attemptStart(steps: Step[]): number | undefined {
  let started: number | undefined;
  for (const step of steps) if (step.state === "review") started = step.startedAt;
  return started;
}

/// Where the review step stands against its two levers, right now — asked at every
/// dispatch point, since a bound read once would bound only the first child.
export function stepBound(
  ctx: HandlerCtx,
  budgetMinutes: number,
  now: number,
  started?: number,
): StepBound {
  const minutes = Math.max(0, budgetMinutes);
  const at = started ?? attemptStart(ctx.steps) ?? now;
  const usedMs = Math.max(0, now - at);
  const usedMinutes = Math.ceil(usedMs / MINUTE_MS);
  const deadline = ctx.run.deadlineMs;
  const left = deadline === undefined ? undefined : deadline - now;
  const inert = !capsEnabled();
  const overBudget = minutes > 0 && usedMs >= minutes * MINUTE_MS;
  const insideReserve = left !== undefined && left <= reserveMs();
  const live = !inert && (overBudget || insideReserve);
  return {
    live,
    inert,
    ...(live ? { limit: (overBudget ? "step-minutes" : "cycle-deadline") as StepBoundLimit } : {}),
    usedMinutes,
    budgetMinutes: minutes,
    ...(left === undefined ? {} : { deadlineLeftMs: left }),
  };
}

/** The whole reserve: what handoff needs, plus what the later steps need. */
function reserveMs(): number {
  return handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS;
}

/// The stop the clock describes, or undefined inside both levers. The deadline
/// sentence quotes the reserve as the number the run failed to leave, so one line
/// distinguishes a step bound from a host deadline.

export function stepStopOf(bound: StepBound): StepStop | undefined {
  if (!bound.live || bound.limit === undefined) return undefined;
  const reserve = Math.round(reserveMs() / MINUTE_MS);
  return {
    limit: bound.limit,
    value: bound.limit === "step-minutes" ? bound.budgetMinutes : reserve,
    used: bound.usedMinutes,
    reason:
      bound.limit === "step-minutes"
        ? `review STEP stopped: minutes budget ${String(bound.budgetMinutes)} exceeded (used ${String(bound.usedMinutes)})`
        : `review STEP stopped: cycle deadline left ${String(Math.max(0, Math.round((bound.deadlineLeftMs ?? 0) / MINUTE_MS)))} min, inside the ${String(reserve)} min reserve for publish, ci, land and handoff (used ${String(bound.usedMinutes)})`,
  };
}

/** The lane named when the re-review of the fix never ran. */
export const RE_REVIEW_LANE = "adversarial re-review";

/** How many lane names one disclosure lists; the rest are counted, not named. */
export const LANES_CAP = 8;

/** The record, with its lane names neutralised and count-capped on the way in. */
export function reviewBoundRecord(
  stop: StepStop,
  wave: ReviewWave,
  lanes: string[],
): ReviewBoundRecord {
  const named = lanes.map((lane) => neutraliseEvidence(lane)).filter((l) => l !== "");
  return { wave, unreviewedLanes: named.slice(0, LANES_CAP), reason: stop.reason };
}
/**
 * The comment that discloses an unreviewed head on the PR: `publish` ran before
 * this step, so the PR body cannot carry it. The list printed is the list the
 * record holds, so a clipped disclosure never reads as the whole one.
 */
export function reviewBoundComment(rec: ReviewBoundRecord): string {
  const lanes = rec.unreviewedLanes.map((lane) => `- ${lane}`).join("\n");
  return [
    `work-lean: the review step stopped at its time bound and did not finish (${rec.reason}).`,
    `Wave reached: ${rec.wave}. Lanes left unreviewed:`,
    lanes === "" ? "- (none named)" : lanes,
    "",
    "These lanes were never judged on this head; nothing else in the run reviewed them.",
  ].join("\n");
}
