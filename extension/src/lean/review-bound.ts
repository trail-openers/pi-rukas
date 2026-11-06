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
type StepBoundLimit = "step-minutes" | "cycle-deadline";

/**
 * What the step's clock says, and the stop it describes. `live` past a lever means
 * dispatch nothing further; `inert` means the caps master switch is off, so the
 * step stops nothing and says so with the same disclosure `armBudget`'s `warning`
 * carries for a child. `limit`, `value` and `reason` are present exactly when a
 * stop exists — they are the record's own fields, so one shape carries both.
 */
export interface StepStop {
  live: boolean;
  inert: boolean;
  limit?: StepBoundLimit;
  /** Minutes spent, the number the disclosure prints. */
  usedMinutes: number;
  /** The lever's own number: the budget's minutes, or the reserve's. */
  value?: number;
  /** The stop's sentence — never `budgetSentence`'s wording, which names a CHILD's
   * lever: "one child ran long" and "the step ran out" must stay two readable facts. */
  reason?: string;
}

/// The newest review entry is this attempt's own, so a handler driven outside the
/// engine still measures from the start the durable log recorded.
function attemptStart(steps: Step[]): number | undefined {
  let started: number | undefined;
  for (const step of steps) if (step.state === "review") started = step.startedAt;
  return started;
}

/// Where the review step stands against its two levers, right now — asked at every
/// dispatch point, since a bound read once would bound only the first child. The
/// budget's minutes are read verbatim (no new knob); 0 means the operator disabled it.
export function stepBound(ctx: HandlerCtx, budgetMinutes: number, now: number): StepStop {
  const minutes = Math.max(0, budgetMinutes);
  const at = attemptStart(ctx.steps) ?? now;
  const usedMs = Math.max(0, now - at);
  const left = ctx.run.deadlineMs === undefined ? undefined : ctx.run.deadlineMs - now;
  const overBudget = minutes > 0 && usedMs >= minutes * MINUTE_MS;
  const insideReserve = left !== undefined && left <= reserveMs();
  const limit = overBudget ? "step-minutes" : insideReserve ? "cycle-deadline" : undefined;
  const live = limit !== undefined && capsEnabled();
  const usedMinutes = Math.max(0, Math.ceil(usedMs / MINUTE_MS));
  const reserve = reserveMinutes();
  return {
    live,
    inert: !capsEnabled(),
    ...(live ? { limit } : {}),
    usedMinutes,
    ...(live
      ? {
          value: limit === "step-minutes" ? minutes : reserve,
          reason:
            limit === "step-minutes"
              ? `review STEP stopped: minutes budget ${String(minutes)} exceeded (used ${String(usedMinutes)})`
              : `review STEP stopped: cycle deadline left ${String(Math.max(0, Math.round((left ?? 0) / MINUTE_MS)))} min, inside the ${String(reserve)} min reserve for publish, ci, land and handoff (used ${String(usedMinutes)})`,
        }
      : {}),
  };
}

/** The whole reserve: what handoff needs, plus what the later steps need. */
function reserveMs(): number {
  return handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS;
}
/** The reserve in minutes — the number the deadline sentence quotes, so one line
 * distinguishes a step bound from a host deadline. */
function reserveMinutes(): number {
  return Math.round(reserveMs() / MINUTE_MS);
}

/** How many lane names one disclosure lists; the rest are counted, not named.
 * Owned here because this module writes the disclosure; the validator imports it
 * rather than restating the bound. */
export const LANES_CAP = 8;

/** The longest stop sentence the record may hold: the record's own reason bound,
 * plus the digit slack the deadline sentence's two number slots carry. The field is
 * bounded by its writer (`stepBound` above) rather than by a free number. */
export const MAX_REASON_CHARS = 320;

/// The record, with its lane names neutralised and count-capped on the way in, and
/// the stop's sentence — which {@link stepBound} only fills in when it is a stop, so
/// the reader still has to ask.

export function reviewBoundRecord(
  stop: StepStop,
  wave: ReviewWave,
  lanes: string[],
): ReviewBoundRecord {
  const named = lanes.map((lane) => neutraliseEvidence(lane)).filter((l) => l !== "");
  return {
    wave,
    unreviewedLanes: named.slice(0, LANES_CAP),
    reason: stop.reason ?? `review STEP stopped at ${String(stop.value)}`,
  };
}

/// The comment that discloses an unreviewed head on the PR: `publish` ran before
/// this step, so the PR body cannot carry it. The list printed is the list the
/// record holds, so a clipped disclosure never reads as the whole one.

export function reviewBoundComment(rec: ReviewBoundRecord): string {
  const lanes = rec.unreviewedLanes.length === 0 ? "- (none named)" : rec.unreviewedLanes.map((lane) => `- ${lane}`).join("\n");
  return `work-lean: the review step stopped at its time bound (${rec.reason}); wave ${rec.wave}; these lanes were never judged:\n${lanes}`;
}
