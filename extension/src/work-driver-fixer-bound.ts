/**
 * work-driver-fixer-bound — WHICH clock armed a fixer's bound, said once and
 * carried to every surface that has to explain the kill (#1798).
 *
 * A lens-fix developer killed at its own bound used to cap as
 * `step-failed:lens-fix` with cause `environment` — "clear the environment
 * fault the evidence names (the provider, the host or the deadline)". Measured
 * on three field cycles (v0.14.27): in every one the child was still producing
 * output seconds before the kill, nothing in the environment had failed, and
 * the bound that fired was pi-rukas's own (`PI_ENSEMBLE_LENS_FIX_BOUND_MS`
 * twice at 45 min, the caller's cycle deadline once). The advice sent the
 * operator to restart the cycle and burn the same hours again, and named a
 * pi-rukas default as if it were the host's clock.
 *
 * The facts existed and were thrown away. `reviewFixDispatchBoundMs` resolves
 * the bound — its own ceiling, the review wall clock, or the caller's deadline
 * — traces it, and returns a NUMBER. Nothing downstream could tell a fixer
 * killed at its 45-minute ceiling from one killed by the 90-minute review clock
 * or by the spawn backstop, so the generic cause table answered `environment`
 * for all three.
 *
 * This module is the single place that names those clocks: the source union,
 * the env knob each one is set by, the minutes the bound ran for, and the
 * operator sentence for the park. A leaf: no value imports from the driver, so
 * the budget module, the completion-event builder and the cause classifier can
 * all read it without a cycle.
 */

import { LENS_FIX_BOUND_ENV, REVIEW_WALL_CLOCK_ENV } from "./review-budget.ts";

/** The cycle-deadline knob. Spelled here rather than imported from the caller
 *  contract's module so this stays a leaf with no runtime imports at all. */
export const CYCLE_DEADLINE_ENV = "PI_ENSEMBLE_CYCLE_DEADLINE";

/** The spawn backstop — the only knob the generic kill wording may name for a
 *  fixer, and then only when NOTHING above it armed the bound. */
export const SPAWN_BACKSTOP_ENV = "PI_ENSEMBLE_SPAWN_TIMEOUT_MS";

/**
 * Which clock armed a fixer dispatch. Exactly one value is recorded per armed
 * dispatch, at the moment the bound is resolved:
 *
 *  - `fixer-bound` — the fixer's own ceiling (`PI_ENSEMBLE_LENS_FIX_BOUND_MS`),
 *    i.e. the loop budget left MORE than that and the ceiling won;
 *  - `review-clock` — the review loop's wall clock left less than the ceiling,
 *    so `PI_ENSEMBLE_REVIEW_WALL_CLOCK_MS` set the bound;
 *  - `cycle-deadline` — the caller's whole-cycle deadline clamped what both
 *    above resolved to (`clampToCycleDeadline` in the spawn layer).
 */
export type FixerBoundSource = "fixer-bound" | "review-clock" | "cycle-deadline";

/** A fixer's resolved bound: the duration AND which clock set it. The pair
 *  travels together from `reviewFixDispatchBound` to the completion event,
 *  which is where a kill learns the knob to name. */
export type FixerBound = { boundMs: number; source: FixerBoundSource };

/** The knob an operator raises for one source. Never the backstop: that is the
 *  fallback for a kill NO source claims, and naming it for a fixer's own bound
 *  is the misattribution this union exists to end. */
export function fixerBoundEnv(source: FixerBoundSource): string {
  switch (source) {
    case "fixer-bound":
      return LENS_FIX_BOUND_ENV;
    case "review-clock":
      return REVIEW_WALL_CLOCK_ENV;
    case "cycle-deadline":
      return CYCLE_DEADLINE_ENV;
  }
}

/** One bounded clause naming a source and its knob. The builder renders it
 *  into the kill's `errorTail`; the classifier reads the SAME strings back out
 *  of the tail, so this is the only site that may spell them. */
export function fixerBoundClause(source: FixerBoundSource, boundMs: number): string {
  return `pi-rukas's own ${source} bound of ${Math.round(boundMs / 60_000)}m (${fixerBoundEnv(source)})`;
}

/**
 * The operator sentence for a lens-fix step that halted on a kill pi-rukas's
 * own clock produced (#1798). No provider, no host, no "clear the deadline":
 * the child was doing its job and ran out of the time the harness gave it, so
 * the only actions are the bound that fired and re-running the step.
 */
export function lensFixBoundKillAction(source: FixerBoundSource, issue: number): string {
  const minutes = source === "fixer-bound" ? " (the fixer's own ceiling, 45 min by default)" : "";
  return `raise ${fixerBoundEnv(source)}${minutes} and re-run \`/work ${issue}\` — the PR is still open and the review findings are posted to it, and the fixer's commits, if it made any, are already landed by the partial-fix path`;
}
