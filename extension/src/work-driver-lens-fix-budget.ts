/**
 * work-driver-lens-fix-budget — enforce the review-loop wall clock DURING the
 * fixer dispatch, not only at the next verdict boundary.
 *
 * The 90-minute budget was printed every second and never acted on. Measured on
 * example-owner/orchard cycle cycle-id: the status line ticked `cap 93m21s/90m`
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
 *  - #1742 — the fixer's bound is the budget left MINUS the owed lens round's
 *    floor (`lensRoundReserveMs()`, default `MIN_USEFUL_MS["lens-review"]`).
 *    A committed fix owes a re-review; a fixer free to spend everything but
 *    the re-review broke the loop's contract at its worst moment. The refused
 *    owed round reuses the round-cap's disclosure route: adversarial approved
 *    + non-critical residuals POSTED to the PR ⇒ `ci`, anything else ⇒
 *    `handoff`. The refused step and the knob are named in the cap evidence
 *    (#1695).
 *  - #1644 — the develop fix pass the adversarial gate requests is PARKED,
 *    not merely bound, when the loop has less than `MIN_USEFUL_MS.develop`
 *    left: zero dispatches with a named cap, instead of a dispatch armed at
 *    the 60-second floor and killed to produce nothing.
 *  - `handoff` and `merged` are never capped: the comment is the whole point of
 *    a handoff, and merging a green PR is the cycle's payoff.
 *  - The clock itself is unchanged — `pipelineState.reviewCapStartedAt`, set
 *    on entering lens-review and persisted, so the budget survives a resume.
 *    A state file with no clock is a review that has not run: nothing to cap.
 *  - Escape hatch: `PI_ENSEMBLE_REVIEW_ENFORCE=0` restores the previous shape
 *    (budget displayed, never enforced).
 */

import { adversarialGateApproved } from "./adversarial-findings.ts";
import { notifyAgent } from "./agent-message.ts";
import { REVIEW_WALL_CLOCK_ENV, reviewWallClockMs } from "./review-budget.ts";
import { childBoundGraceMs, lensChildBoundMs } from "./spawn-child-bound.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { MIN_USEFUL_MS } from "./work-driver-deadline.ts";
import { discloseResidualsAndRoute } from "./work-driver-lens-cap.ts";
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
  // #1742 — the owed lens round's floor is withheld from the fixer's bound:
  // a fixer that consumes the whole budget leaves a round that must be
  // refused at its own start gate, which is the cap the loop could not shed.
  return Math.min(
    Math.max(remaining - lensRoundReserveMs(), MIN_FIX_DISPATCH_MS),
    boundCeiling(requestedTimeoutMs),
  );
}

/**
 * #1742 — the slice of the loop budget a fixer may never spend: the minimum
 * a lens round needs to be worth starting (`MIN_USEFUL_MS["lens-review"]`).
 *
 * A committed fix OWES a re-review: the loop's contract is fix → re-review,
 * and a budget that lets the fixer spend everything but the re-review breaks
 * it at exactly the moment it matters — the findings have just been answered
 * and nothing has verified the answer. Measured: a lens-fix took the entire
 * remaining budget, the owed round was refused by this module's own start
 * gate, and the cycle capped with the fix unverified.
 *
 * Read per call (like every other knob here) so tests can flip it. Default:
 * the lens round's own minimum — reserving less than a round's floor would
 * reserve a round that gets refused anyway.
 */
export function lensRoundReserveMs(): number {
  return MIN_USEFUL_MS["lens-review"] ?? 10 * 60_000;
}

/**
 * #1242 / #1564 — each lens child's run bound: its own (30 min), shortened so
 * the wrap-up steer lands a grace before the loop budget runs out and the kill
 * at it. A round that crosses the cap ends there, its unfinished lanes
 * not-reviewed, instead of every lens running on past it.
 */
export function lensRoundChildBoundMs(state: WorkState, now: number): number {
  const own = lensChildBoundMs();
  const remaining = reviewRemainingMs(state, now);
  if (remaining === undefined) return own;
  return Math.min(own, Math.max(MIN_FIX_DISPATCH_MS, remaining - childBoundGraceMs()));
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
  step: "lens-fix" | "lens-review" | "develop",
  now: number,
): Promise<WorkState> {
  const remaining = reviewRemainingMs(state, now);
  // The lens-fix needs its own floor PLUS the owed round's reserve: a fixer
  // that can only run by eating the re-review's floor is the #1742 shape, and
  // it is refused here rather than at the round's own start gate.
  const base = MIN_USEFUL_MS[step] ?? 0;
  const reserve = step === "lens-fix" ? lensRoundReserveMs() : 0;
  const need = base + reserve;
  if (remaining === undefined || remaining >= need) return state;
  const capMs = reviewWallClockMs();
  const elapsedMin = Math.round((capMs - remaining) / 60_000);
  const round = state.pipelineState.reviewRound;
  const what =
    step === "lens-fix"
      ? "lens-fix not dispatched"
      : step === "develop"
        ? "the adversarial fix pass (develop) was not dispatched"
        : `lens-review round ${round + 1} not started`;
  const why =
    remaining <= 0
      ? "so the step was stopped before it started rather than left running past its own printed budget"
      : `and ${Math.round(remaining / 60_000)}m of it is left — ${step} needs at least ${base / 60_000}m${reserve > 0 ? ` and ${reserve / 60_000}m of the budget is reserved for the owed lens round` : ""} to do useful work`;
  const evidence = `${what}: the review loop has run ${elapsedMin}m (round ${round}) against the ${capMs / 60_000}-minute cap (${REVIEW_WALL_CLOCK_ENV}), ${why}.`;
  trace(`work-driver: ${step} — the review loop cannot fit the step — ${evidence}`);
  // #1695 — a REFUSED owed round is not the same event as an overrun round:
  // the fix already landed, the adversarial gate has since re-checked the
  // diff, and the only thing missing is the round that would have re-flagged
  // it. That is the round-cap's own merge-worthy shape, so it takes the
  // round-cap's own route: disclose the residuals to the PR, and only if the
  // post lands does the cycle carry on to CI (a refused round whose findings
  // went undisclosed parks — same rule as work-driver-lens-cap.ts).
  let next: WorkState = state;
  let nextStep: "ci" | "handoff" = "handoff";
  if (step === "lens-review") {
    const owed = lastOwedRoundFindings(state);
    // Same bar as the round cap: non-critical findings, adversarial gate
    // approved on the current diff. A CRITICAL_ISSUES_FOUND or an unreadable
    // gate parks — the round being refused is the round that would have
    // caught it.
    if (owed && owed.verdict === "ISSUES_FOUND" && adversarialGateApproved(state.eventLog)) {
      const routed = await discloseResidualsAndRoute(ctx, next, round, owed.verdict, owed.findings);
      nextStep = routed.nextStep;
      next = routed.state;
    }
  }
  next = appendEvent(next, {
    kind: "cap-hit",
    at: now,
    cap: "lens-review-timeout",
    reviewRound: round,
    evidence,
    nextStep,
  });
  next = {
    ...next,
    pipelineState: { ...next.pipelineState, currentStep: nextStep },
  };
  await persistCycle(ctx, next);
  notifyAgent(
    ctx.host,
    `pi-rukas: /work for issue #${ctx.issue} hit the ${capMs / 60_000}-minute review-loop cap (${elapsedMin}m elapsed, round ${round}) — ${what}. ${
      nextStep === "ci"
        ? "The adversarial gate approved the fix and the outstanding findings were disclosed to the PR, so the cycle carries on to CI."
        : "Routing to handoff so the comment posts."
    }`,
  );
  return next;
}

/** The last lens round's verdict + findings blob, or `undefined` when no
 *  round has recorded issues (nothing owed, nothing to disclose). */
function lastOwedRoundFindings(
  state: WorkState,
): { verdict: string; findings: string } | undefined {
  const last = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<(typeof state.eventLog)[number], { kind: "lens-issues-found" }> =>
        e.kind === "lens-issues-found",
    );
  if (!last?.findings) return undefined;
  return { verdict: last.verdict, findings: last.findings };
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
 * #1644 — the pre-dispatch park for the develop fix pass the adversarial gate
 * requests after a lens-fix. That pass was BOUND (it shares the lens-fix
 * bound) but never PARKED: with no budget left it dispatched anyway and the
 * bound killed it at 60s, burning a dispatch to produce nothing. Zero
 * dispatches with a named cap beats a dispatch guaranteed to be killed.
 */
export function parkDevelopFixOverrun(
  ctx: CycleContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  return parkReviewNoFit(ctx, state, "develop", now);
}

/**
 * #1644 — does the develop fix pass fit the budget the loop has left? The
 * dispatch closure asks this BEFORE the fan-out so the step can short-circuit
 * the safety-net/verify gates the same way the deferred-leftover park does;
 * `parkDevelopFixOverrun` then records the cap with those gates skipped.
 * Fits when enforcement is off, no clock, or `MIN_USEFUL_MS.develop` is left.
 */
export function developFixPassFits(state: WorkState, now: number): boolean {
  const remaining = reviewRemainingMs(state, now);
  return remaining === undefined || remaining >= (MIN_USEFUL_MS.develop ?? 0);
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
