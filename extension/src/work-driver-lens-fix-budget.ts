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
 * `wall-clock` cap) is reached from `applyLensVerdict`, i.e. only AFTER a lens
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
 * all: the cycle parks with a `wall-clock` cap-hit routed to handoff, which is
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
 *  - Already past the bound: the fixer is never dispatched (the overrun is what
 *    the cap exists to stop) and a `wall-clock` cap-hit routes to handoff.
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
import { handoffDispatchTimeoutMs } from "./work-driver-handoff.ts";
import { type WorkState, type WorkStep, appendEvent, persistCycle } from "./workflow-state.ts";

/** Floor for a bound we actually arm. Below this a fixer cannot produce a
 *  commit, so "no time left" and "almost none" get the same honest answer. */
export const MIN_FIX_DISPATCH_MS = 60_000;

/** The bound armed when the budget is already spent: not unbounded (that is
 *  the bug) and not immediate — the child is killed with the structured
 *  `timeout` killCause and the step fails through the normal router. */
const MAX_SAFE_BOUND_MS = MIN_FIX_DISPATCH_MS;

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
 * The dispatch bound the remaining loop budget leaves, if any.
 *
 * Returns `undefined` when the dispatch runs uncapped: enforcement off, no
 * review clock, a step outside the review loop, the budget still comfortable,
 * or a step the cap must never interrupt. Never returns a number LARGER than
 * `requestedTimeoutMs` — the cap only ever shortens a dispatch.
 */
export function reviewFixDispatchBoundMs(
  state: WorkState,
  step: WorkStep,
  now: number,
  requestedTimeoutMs?: number,
): number | undefined {
  if (!reviewEnforceEnabled()) return undefined;
  if (step !== "lens-fix") return undefined;
  const elapsed = reviewElapsedMs(state, now);
  if (elapsed === undefined) return undefined;
  const remaining = reviewWallClockMs() - elapsed;
  // Past the cap: a minimal bound stays armed rather than leaving the fixer
  // unbounded — unbounded is the bug. (The lens-fix caller parks instead of
  // dispatching; the develop fix-pass caller has no park of its own, so this
  // is the branch that keeps it from running forever.)
  if (remaining <= 0) return Math.min(MAX_SAFE_BOUND_MS, boundCeiling(requestedTimeoutMs));
  // The handoff grace is held back so a fixer killed by the budget still has
  // time to hand off before the caller's own kill (the #1238 deadline shape).
  if (remaining <= MIN_FIX_DISPATCH_MS + handoffDispatchTimeoutMs()) return undefined;
  const bound = Math.min(remaining, boundCeiling(requestedTimeoutMs));
  return bound < MIN_FIX_DISPATCH_MS ? undefined : bound;
}

/** Never lengthen a dispatch the caller already bounded. */
function boundCeiling(requestedTimeoutMs?: number): number {
  return requestedTimeoutMs ?? Number.POSITIVE_INFINITY;
}

/**
 * The pre-dispatch park for a fixer the loop budget has already outlived.
 *
 * Mirrors `parkLensFixReposition`: append the cap-hit, move `currentStep` to
 * `handoff`, persist, and notify — and do NOT dispatch. `nextStep` routes a
 * trailing `cap-hit` on its own `nextStep`, so the loop arrives at handoff and
 * the operator gets the comment + label + notification the budget promised.
 *
 * Returns `state` unchanged when no cap applies (enforcement off, no clock,
 * budget intact): the caller then dispatches as before.
 */
export async function parkLensFixOverrun(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  if (!reviewEnforceEnabled()) return state;
  const elapsed = reviewElapsedMs(state, now);
  const capMs = reviewWallClockMs();
  if (elapsed === undefined || elapsed <= capMs) return state;
  const round = state.pipelineState.reviewRound;
  const evidence = `lens-fix not dispatched: the review loop has run ${Math.round(elapsed / 60_000)}m (round ${round}) against the ${capMs / 60_000}-minute cap, so the fixer was stopped before it started rather than left running past its own printed budget.`;
  trace(`work-driver: lens-fix — review wall-clock cap exceeded — ${evidence}`);
  let next: WorkState = appendEvent(state, {
    kind: "cap-hit",
    at: now,
    cap: "wall-clock",
    reviewRound: round,
    evidence,
    nextStep: "handoff",
  });
  next = { ...next, pipelineState: { ...next.pipelineState, currentStep: "handoff" } };
  await persistCycle(ctx, next);
  notifyAgent(
    ctx.host,
    `pi-rukas: /work for issue #${ctx.issue} hit the ${capMs / 60_000}-minute review-loop cap (${Math.round(elapsed / 60_000)}m elapsed, round ${round}) — the lens-fix developer was not dispatched. Routing to handoff so the comment posts.`,
  );
  return next;
}
