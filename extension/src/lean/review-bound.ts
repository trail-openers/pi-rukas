/**
 * lean/review-bound — the `review` STEP's own wall clock, and what a stop says.
 *
 * `budgets.review.minutes` was armed on every child through `armBudget` and
 * bounded NONE of them as a step: `reviewOutcome` bought two adversarial passes,
 * twelve lens children and one fixer, each with its own per-child bound (30 min
 * for a lens, 30 for the gate, 20 for the fixer), and a child that spent the
 * step's minutes was still inside its own bound. A field run spent 69 of its
 * ~89 minutes in this one step across twelve reviewer dispatches and starved
 * publish, ci and land — a clean, mergeable PR handed back at the deadline. The
 * per-child levers are correct and unchanged; what was missing is the total.
 *
 * Three levers, one of which is deliberately not a bound at all:
 *
 *   - **the step budget** — `budgets.review.minutes`, read verbatim, no new knob.
 *     Spent, the step dispatches no further reviewer or fixer;
 *   - **the deadline reserve** — `handoffAllowanceMs()` (the allowance the
 *     handback needs, the same number `deadlineStopsSteps` compares against)
 *     PLUS {@link REVIEW_DEADLINE_RESERVE_MS} for publish, ci and land. Lean
 *     consults the cycle deadline only BETWEEN steps (`deadline.ts` states the
 *     exemption), so a step already running is unbounded by it; this is the
 *     review step closing that gap for itself;
 *   - **the caps master switch** — under `PI_ENSEMBLE_DISPATCH_CAPS=0` neither
 *     lever stops anything, because both would then be enforcing a bound the
 *     runtime has disabled. `stepBound`'s `inert` says so and the step prints
 *     the same "inert" disclosure `armBudget`'s `warning` carries for a child.
 *
 * **The clock is the durable record, not the closure.** A review attempt that
 * crashes and resumes re-enters `reviewOutcome` with its earlier review entries
 * still in the log, so the spend comes off the newest review step's `startedAt`.
 * A fresh `ctx.now()` would hand a resumed attempt a whole budget again and the
 * run would spend two of them where it has one.
 *
 * **A stop is not one verdict.** Which way the step routes depends on what has
 * actually been reviewed when the clock closes: nothing (pass 1) hands back; a
 * complete, unblocked first round proceeds; a pushed fix goes back through
 * `verify` as `fixed`. Those three readings live in `review.ts`, which owns the
 * loop; this module owns the clock, the shape of a stop, and its disclosure.
 */

import { neutraliseEvidence } from "../comment-evidence.ts";
import { capsEnabled } from "../spawn-child-bound.ts";
import { MINUTE_MS, handoffAllowanceMs } from "./deadline.ts";
import type { HandlerCtx } from "./engine.ts";
import type { ReviewWave } from "./review-args.ts";
import type { Step } from "./state.ts";

/**
 * The time publish, ci and land still need when the review step is asked to
 * stop, ON TOP of {@link handoffAllowanceMs} (which is what the handback needs
 * to write its report). Added to, never replacing: `deadlineStopsSteps` and
 * `clampToCycleDeadline` keep comparing against the allowance alone, and the
 * review step is the one step long enough — a full review, a fix wave and a
 * re-review, serially — to need room for the steps after it as well.
 */
export const REVIEW_DEADLINE_RESERVE_MS = 15 * MINUTE_MS;

/** Why the step stopped dispatching: its own budget, or the caller's deadline. */
export type StepBoundLimit = "step-minutes" | "cycle-deadline";

/** What the step's clock says about the instant a child is about to be paid for. */
export interface StepBound {
  /** Live, and within every lever. Dispatch the next child. */
  live: boolean;
  /** The step is not stopping anything because the caps master switch is off. */
  inert: boolean;
  /** Which lever closed, present exactly when `live` is false and the bound is live. */
  limit?: StepBoundLimit;
  /** Minutes spent, the number the disclosure prints. */
  usedMinutes: number;
  /** The budget the spend is measured against, in minutes. */
  budgetMinutes: number;
  /** Ms left before the deadline reserve runs out; absent with no deadline. */
  deadlineLeftMs?: number;
}

/**
 * When this attempt's review step began, from the durable log.
 *
 * The engine writes a step ahead with its `startedAt` before the handler runs,
 * and on a crash-mid-step it re-enters the SAME entry rather than appending a
 * new one — so the newest review entry is this attempt's own. Reading it from the
 * log rather than from a closure is what makes a resume count what its crashed
 * self already spent: the entry survives, the closure does not.
 */
function attemptStart(steps: Step[]): number | undefined {
  let started: number | undefined;
  for (const step of steps) if (step.state === "review") started = step.startedAt;
  return started;
}

/**
 * Where the review step stands against its two time levers, right now.
 *
 * Read at each dispatch point rather than once: the levers are read from the
 * durable record and the run's deadline, both of which outlive a child, and a
 * bound asked once at the top of the step would be a bound on the FIRST child
 * only. `now` is the injected clock, so a case drives the elapsed time without
 * sleeping.
 */
export function stepBound(
  ctx: HandlerCtx,
  budgetMinutes: number,
  now: number,
  started?: number,
): StepBound {
  const minutes = Math.max(0, budgetMinutes);
  // Three starts, in the order a resume makes them necessary: the pending entry
  // the engine wrote for THIS visit (`stepStartedAt`, the normal case); the newest
  // review entry in the log, which is what a handler driven outside the engine —
  // or a test — hands over; and finally `now`, which reads as "this attempt has
  // spent nothing", the honest default when nobody recorded a beginning.
  const at = started ?? attemptStart(ctx.steps) ?? now;
  const usedMs = Math.max(0, now - at);
  const usedMinutes = Math.ceil(usedMs / MINUTE_MS);
  const deadline = ctx.run.deadlineMs;
  const left = deadline === undefined ? undefined : deadline - now;
  const inert = !capsEnabled();
  const overBudget = minutes > 0 && usedMs >= minutes * MINUTE_MS;
  const insideReserve =
    left !== undefined && left <= handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS;
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

/**
 * The step-bound verdict: the record {@link reviewBoundRecord} builds and the
 * `reason` line the step logs with it.
 *
 * `reason` names the lever, its number and what the step spent, in the shape
 * `budgetSentence` already uses for a per-child breach — the two are different
 * clocks and must not read as one another, which is why this one says
 * `review STEP` where that one says `review stopped`.
 */
export interface StepStop {
  limit: StepBoundLimit;
  value: number;
  used: number;
  reason: string;
}

/** The stop the clock describes, or undefined when the step is inside both levers. */
export function stepStopOf(bound: StepBound): StepStop | undefined {
  if (!bound.live || bound.limit === undefined) return undefined;
  const reserveMinutes = Math.round((handoffAllowanceMs() + REVIEW_DEADLINE_RESERVE_MS) / MINUTE_MS);
  return {
    limit: bound.limit,
    value: bound.limit === "step-minutes" ? bound.budgetMinutes : reserveMinutes,
    used: bound.usedMinutes,
    reason:
      bound.limit === "step-minutes"
        ? `review STEP stopped: minutes budget ${String(bound.budgetMinutes)} exceeded (used ${String(bound.usedMinutes)})`
        : `review STEP stopped: cycle deadline left ${String(Math.max(0, Math.round((bound.deadlineLeftMs ?? 0) / MINUTE_MS)))} min, inside the ${String(reserveMinutes)} min reserve for publish, ci, land and handoff (used ${String(bound.usedMinutes)})`,
  };
}

/**
 * Why the step stopped, in its own words, for the ungated log line and the
 * recorded outcome. One renderer so the operator's stderr and the durable
 * record cannot disagree about which lever closed.
 */
export function stepBoundSentence(stop: StepStop): string {
  return stop.reason;
}

/** The lane name printed when the re-review of the fix did not run. */export const RE_REVIEW_LANE = "adversarial re-review";

/** How many lane names one disclosure lists. The rest are counted, not named. */
export const LANES_CAP = 8;

/**
 * What a `review` step records when its OWN clock stopped it: the wave it
 * reached, the lanes that never got a verdict, and the stop's own sentence.
 *
 * The step's per-child levers (`budgets.review` armed through `armBudget`) bound
 * each reviewer and fixer separately, so a step could spend hours inside bounds
 * that each held. This is the second, distinct clock, and it needs a field of its
 * own rather than the budget trio: `limit`/`value`/`used` belong to a `budget`
 * kind and `review` has none, and a reader must be able to tell "the fixer hit
 * its 20 minutes" apart from "the step as a whole hit its 30 and stopped early".
 *
 * Absent means the step finished inside its bound, which is the normal case and
 * every reader's default: no bound stop, nothing undisclosed.
 */
export interface ReviewBoundRecord {
  /** The wave the step was IN when the clock closed — the step's own vocabulary. */
  wave: ReviewWave;
  /** The lanes that never got a verdict: lens names, plus {@link RE_REVIEW_LANE}. */
  unreviewedLanes: string[];
  /** Which lever closed, its number and what the step spent. One bounded line. */
  reason: string;
}

export function reviewBoundRecord(
  stop: StepStop,
  wave: ReviewWave,
  lanes: string[],
): ReviewBoundRecord {
  const named = lanes
    .map((lane) => neutraliseEvidence(lane))
    .filter((lane) => lane !== "")
    .slice(0, LANES_CAP);
  return { wave, unreviewedLanes: named, reason: stepBoundSentence(stop) };
}

/**
 * The comment body that discloses an unreviewed head on the PR.
 *
 * `publish` runs BEFORE `review`, so the body the PR was opened with cannot
 * carry this and the step posts one comment instead. Bounded and neutralised
 * upstream in {@link reviewBoundRecord}; the count printed is the count the
 * record holds, so a clipped list never reads as the whole list.
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
