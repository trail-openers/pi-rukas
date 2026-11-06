/**
 * lean/review-bound — the `review` STEP's own wall clock, and what a stop says.
 *
 * `budgets.review.minutes` was armed on every child through `armBudget` and bounded none
 * of them as a step: the step buys its children serially, each inside its own per-child
 * bound, so the total was unbounded and a field run spent 69 of its ~89 minutes here and
 * starved publish, ci and land. The child levers are unchanged.
 *
 * Two levers and an out: the **step budget** (`budgets.review.minutes`, read verbatim
 * — no new knob); the **deadline reserve**, `handoffAllowanceMs` PLUS
 * {@link REVIEW_DEADLINE_RESERVE_MS} for publish, ci and land, which the engine's
 * BETWEEN-steps deadline check cannot protect because it never looks while a step
 * runs; and the **caps master switch**, under which neither lever stops anything and
 * `inert` says so rather than reporting a disabled bound. The clock is the DURABLE
 * record, not a closure — the spend comes off this attempt's `startedAt`, so a resumed
 * attempt cannot be handed a whole budget again. **A stop is not one verdict** (nothing
 * reviewed, a clean first round, and a pushed fix route three ways): `review.ts` owns
 * those readings, this module the clock and the stop's shape.
 */

import { neutraliseEvidence } from "../comment-evidence.ts";
import { capsEnabled } from "../spawn-child-bound.ts";
import { MINUTE_MS, handoffAllowanceMs } from "./deadline.ts";
import type { HandlerCtx } from "./engine.ts";
import type { LensRound, ReviewWave } from "./review-args.ts";
import { LENSES_PER_PASS } from "./review-waves.ts";

/// The time publish, ci and land still need when this step is asked to stop, ON TOP
/// of `handoffAllowanceMs` — added to, never replacing, so the engine's own deadline
/// checks keep comparing against the allowance alone.

export const REVIEW_DEADLINE_RESERVE_MS = 15 * 60_000;

/// What the step's clock says, and the stop it describes. `live` past a lever means
/// dispatch nothing further; `inert` means the caps master switch is off, so the step
/// stops nothing and says so with the disclosure `armBudget`'s `warning` carries for a
/// child. `limit`/`value`/`reason` are present exactly when a stop exists and are the
/// record's own fields, and `reason` is never `budgetSentence`'s wording: "one child ran
/// long" and "the step ran out" stay two readable facts.

export interface StepStop {
  live: boolean;
  inert: boolean;
  limit?: "step-minutes" | "cycle-deadline";
  /** Minutes spent, the number the disclosure prints. */
  usedMinutes: number;
  value?: number;
  reason?: string;
}

/// Where the review step stands against its two levers, right now — asked at every
/// dispatch point, since a bound read once would bound only the first child. The
/// budget's minutes are read verbatim (no new knob); 0 means the operator disabled it.
export function stepBound(ctx: HandlerCtx, budgetMinutes: number, now: number): StepStop {
  const minutes = Math.max(0, budgetMinutes);
  // The newest review entry is this attempt's own, so a handler driven outside the
  // engine still measures from the start the durable log recorded.
  let at = now;
  for (const step of ctx.steps) if (step.state === "review") at = step.startedAt;
  const usedMs = Math.max(0, now - at);
  const left = ctx.run.deadlineMs === undefined ? undefined : ctx.run.deadlineMs - now;
  const overBudget = minutes > 0 && usedMs >= minutes * MINUTE_MS;
  const insideReserve = left !== undefined && left <= reserveMs();
  const limit = overBudget ? "step-minutes" : insideReserve ? "cycle-deadline" : undefined;
  const live = limit !== undefined && capsEnabled();
  const usedMinutes = Math.max(0, Math.ceil(usedMs / MINUTE_MS));
  const reserve = reserveMinutes();
  if (!live) return { live, inert: !capsEnabled(), usedMinutes };
  const deadline = `cycle deadline left ${String(Math.max(0, Math.round((left ?? 0) / MINUTE_MS)))} min, inside the ${String(reserve)} min reserve for publish, ci, land and handoff`;
  return {
    live,
    inert: !capsEnabled(),
    limit,
    usedMinutes,
    value: limit === "step-minutes" ? minutes : reserve,
    reason: `review STEP stopped: ${limit === "step-minutes" ? `minutes budget ${String(minutes)} exceeded` : deadline} (used ${String(usedMinutes)})`,
  };
}

/** The whole reserve: what handoff needs, plus what the later steps need; and the
 * same in minutes, the number the deadline sentence quotes so one line separates a
 * step bound from a host deadline. */
function reserveMs(): number {
  return handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS;
}
function reserveMinutes(): number {
  return Math.round(reserveMs() / MINUTE_MS);
}

/// The lanes a stop must disclose: the roster the step buys minus the lens children
/// that ran, named off the round's own records (a round that named nothing reports the
/// count alone, so a disclosure never claims lanes nobody can read), plus the
/// re-review lane when a pushed fix went unjudged.
export function unjudgedLenses(round: LensRound | undefined, reReview = false): string[] {
  const named = (round?.lenses ?? []).map((lens) => lens.lens).filter((n) => n !== "");
  const missing = LENSES_PER_PASS - named.length;
  const lanes =
    missing <= 0 ? [] : named.length === 0 ? [`${String(missing)} lenses unrun`] : named;
  return reReview ? ["adversarial re-review", ...lanes] : lanes;
}

/**
 * What the `review` step records when its OWN clock stopped it: the wave it reached, the
 * lanes that never got a verdict, and the stop's own sentence. Lens names come from a
 * skill roster — outside this process — so each is neutralised and count-capped on entry.
 */
export interface ReviewBoundRecord {
  wave: "full" | "fix";
  unreviewedLanes: string[];
  reason: string;
}

/// How many lane names one disclosure lists (the rest are counted, not named), and the
/// longest stop sentence the record may hold — its own reason bound plus the digit slack
/// the deadline sentence's two number slots carry. Owned where the disclosure is written,
/// so the validator bounds the field by its writer.
export const LANES_CAP = 8;
export const MAX_REASON_CHARS = 320;

/// The record, with its lane names neutralised and count-capped on the way in; the
/// loader refuses one that breaks these bounds (`reviewBoundProblem`). `stop.reason` is
/// set only when the stop is live.
export function reviewBoundRecord(
  stop: StepStop,
  wave: ReviewWave,
  lanes: string[],
): ReviewBoundRecord {
  const named = lanes
    .map((lane) => neutraliseEvidence(lane))
    .filter((l) => l !== "")
    .slice(0, LANES_CAP);
  return {
    wave,
    unreviewedLanes: named,
    reason: stop.reason ?? `review STEP stopped at ${String(stop.value)}`,
  };
}

/// The comment that discloses an unreviewed head on the PR: `publish` ran before this
/// step, so the PR body cannot carry it. The list printed is the list the record
/// holds, so a clipped disclosure never reads as the whole one.

export function reviewBoundComment(rec: ReviewBoundRecord): string {
  const lanes = rec.unreviewedLanes.map((lane) => `- ${lane}`).join("\n");
  return `work-lean: the review step stopped at its time bound (${rec.reason}); wave ${rec.wave}; these lanes were never judged:\n${lanes === "" ? "- (none named)" : lanes}`;
}
