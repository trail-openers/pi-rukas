/**
 * work-driver-lens-fix-budget — enforce the review-loop wall clock DURING the
 * fixer dispatch, not only at the next verdict boundary.
 *
 * The 90-minute budget was printed every second and never acted on. Measured on
 * janit/tehas cycle 261-261016-054337: the status line ticked `cap 93m21s/90m`
 * … `cap 100m11s/90m`, and the cycle ended only because the operator quit Pi —
 * `session_shutdown … aborted 2 in-flight async jobs — work-driver,
 * developer:lens-fix-1`. No `cap-hit` anywhere in the stream, no handoff, and
 * `cycle.json` recorded `"cap": null, "capReason": null`.
 *
 * The reason is structural: `appendReviewCapHit` (the only writer of the
 * `lens-review-timeout` cap) is reached from `applyLensVerdict`, i.e. only AFTER a lens
 * review has returned, and `runLensFix` itself checked nothing at all. The
 * driver was awaiting a fixer that had already outlived its budget, while the
 * slow-run notice told the PM the driver "retries or parks by itself when it
 * fails". A displayed number nobody enforces is worse than no number: it
 * advertises a bound the harness does not honour.
 *
 * What changed: the cap is checked when the fix loop ENTERS a fixer. A fixer
 * started while time remains is bound to what remains, so it is killed at the
 * bound with the structured `timeout` killCause and the step fails the same way
 * any dispatch failure fails — through the step router — so no new failure mode
 * is introduced. A fixer the budget has already outlived is never dispatched at
 * all: the cycle parks with a `lens-review-timeout` cap-hit routed to handoff, which is
 * the comment + label + notification the budget always promised and never
 * produced.
 *
 * Semantics kept deliberately narrow:
 *  - The bound is only ever APPLIED to the fix loop's dispatches: `lens-fix`,
 *    and the develop pass the adversarial gate requests after a lens-fix (the
 *    one carrying `fixFindings`). No other step inherits it — an ordinary first
 *    develop pass runs uncapped.
 *  - The bound never extends a dispatch: `timeoutMs` is the MINIMUM of the
 *    caller's own bound and what the loop budget leaves.
 *  - Too little budget left to be useful (`MIN_USEFUL_MS`: 15 min for a
 *    lens-fix, 10 min for a lens round — #1567 item 6, #1242): the step is
 *    never started and a `lens-review-timeout` cap-hit routes to handoff. A
 *    lens round started at 84 of 90 min ran 27 min and its findings were
 *    never fixed; that round is now refused, and so is the fixer.
 *  - `handoff` and `merged` are never capped: the comment is the whole point of
 *    a handoff, and merging a green PR is the cycle's payoff.
 *  - The clock itself is unchanged — `pipelineState.reviewCapStartedAt`, set
 *    on entering lens-review and persisted, so the budget survives a resume.
 *    A state file with no clock is a review that has not run: nothing to cap.
 *  - Escape hatch: `PI_ENSEMBLE_REVIEW_ENFORCE=0` restores the previous shape
 *    (budget displayed, never enforced).
 */

import { notifyAgent } from "./agent-message.ts";
import { reviewWallClockMs } from "./review-budget.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { MIN_USEFUL_MS } from "./work-driver-deadline.ts";
import { type WorkState, type WorkStep, appendEvent, persistCycle } from "./workflow-state.ts";

/** The least bound armed on a fix-loop dispatch: with the budget spent, the
 *  develop fix pass (which has no park of its own) is not left unbounded —
 *  that is the bug — nor killed at once; it is killed with the structured
 *  `timeout` killCause and the step fails through the normal router. */
export const MIN_FIX_DISPATCH_MS = 60_000;

/** Enforce the review-loop budget, or only report it? Process env is read per
 *  call so tests can flip it, matching the other escape hatches. */
export function reviewEnforceEnabled(): boolean {
  return process.env.PI_ENSEMBLE_REVIEW_ENFORCE !== "0";
}

/** How long the loop has been running, or `undefined` when no review clock has
 *  been started yet (a cycle that has not reached lens-review). */
export function reviewElapsedMs(state: WorkState, now: number): number | undefined {
  const started = state.pipelineState.reviewCapStartedAt;
  if (typeof started !== "number" || !Number.isFinite(started)) return undefined;
  return now - started;
}

/** Is the cycle inside the review loop? A clock is stamped on entering
 *  lens-review and never cleared, so its presence — not the current step — is
 *  what says the fix loop has begun. */
export function reviewLoopActive(state: WorkState): boolean {
  return reviewElapsedMs(state, 0) !== undefined;
}

/**
 * The loop budget left, or `undefined` when enforcement is off or no review
 * clock has started (a cycle that has not reached lens-review).
 */
function reviewRemainingMs(state: WorkState, now: number): number | undefined {
  if (!reviewEnforceEnabled()) return undefined;
  const elapsed = reviewElapsedMs(state, now);
  return elapsed === undefined ? undefined : reviewWallClockMs() - elapsed;
}

/**
 * The dispatch bound the remaining loop budget leaves, if any.
 *
 * Returns `undefined` when the dispatch runs uncapped: enforcement off, no
 * review clock, or a step outside the review loop. Otherwise the bound is
 * what the budget leaves, never less than `MIN_FIX_DISPATCH_MS` and never
 * more than `requestedTimeoutMs` — the cap only ever shortens a dispatch.
 *
 * #1242 — there used to be a band (1 min + the handoff grace, ~9 min) in
 * which this returned `undefined` and the fixer ran with no loop bound at
 * all, at the tightest moment of the loop. `parkLensFixOverrun` now refuses
 * a lens-fix that cannot do useful work in what is left, and every fixer
 * that is dispatched is bounded.
 */
export function reviewFixDispatchBoundMs(
  state: WorkState,
  step: WorkStep,
  now: number,
  requestedTimeoutMs?: number,
): number | undefined {
  if (step !== "lens-fix") return undefined;
  const remaining = reviewRemainingMs(state, now);
  if (remaining === undefined) return undefined;
  return Math.min(Math.max(remaining, MIN_FIX_DISPATCH_MS), boundCeiling(requestedTimeoutMs));
}

/** Never lengthen a dispatch the caller already bounded. */
function boundCeiling(requestedTimeoutMs?: number): number {
  return requestedTimeoutMs ?? Number.POSITIVE_INFINITY;
}

/**
 * Park before a review-loop step the loop budget cannot fit (#1567 item 6
 * applied to the loop's own clock): append a `lens-review-timeout` cap-hit,
 * move `currentStep` to `handoff`, persist, notify — and do NOT dispatch.
 * `nextStep` routes a trailing `cap-hit` on its own `nextStep`.
 *
 * Returns `state` unchanged when the step fits (enforcement off, no clock,
 * at least `MIN_USEFUL_MS[step]` of the budget left).
 */
async function parkReviewNoFit(
  ctx: CycleContext,
  state: WorkState,
  step: "lens-fix" | "lens-review",
  now: number,
): Promise<WorkState> {
  const remaining = reviewRemainingMs(state, now);
  const need = MIN_USEFUL_MS[step] ?? 0;
  if (remaining === undefined || remaining >= need) return state;
  const capMs = reviewWallClockMs();
  const elapsedMin = Math.round((capMs - remaining) / 60_000);
  const round = state.pipelineState.reviewRound;
  const what =
    step === "lens-fix" ? "lens-fix not dispatched" : `lens-review round ${round + 1} not started`;
  const why =
    remaining <= 0
      ? "so the step was stopped before it started rather than left running past its own printed budget"
      : `and ${Math.round(remaining / 60_000)}m of it is left — ${step} needs at least ${need / 60_000}m to do useful work`;
  const evidence = `${what}: the review loop has run ${elapsedMin}m (round ${round}) against the ${capMs / 60_000}-minute cap, ${why}.`;
  trace(`work-driver: ${step} — the review loop cannot fit the step — ${evidence}`);
  let next: WorkState = appendEvent(state, {
    kind: "cap-hit",
    at: now,
    cap: "lens-review-timeout",
    reviewRound: round,
    evidence,
    nextStep: "handoff",
  });
  next = { ...next, pipelineState: { ...next.pipelineState, currentStep: "handoff" } };
  await persistCycle(ctx, next);
  notifyAgent(
    ctx.host,
    `pi-rukas: /work for issue #${ctx.issue} hit the ${capMs / 60_000}-minute review-loop cap (${elapsedMin}m elapsed, round ${round}) — ${what}. Routing to handoff so the comment posts.`,
  );
  return next;
}

/** The pre-dispatch park for a fixer the loop budget cannot fit (#1416, #1242). */
export function parkLensFixOverrun(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  return parkReviewNoFit(ctx, state, "lens-fix", now);
}

/**
 * #1242 — the pre-start park for a lens round the loop budget cannot fit. A
 * round started at 84 min of a 90-min loop ran 27 min, and its findings were
 * posted but never fixed. The first round has no clock yet and always runs.
 */
export function parkLensRoundNoFit(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  return parkReviewNoFit(ctx, state, "lens-review", now);
}
