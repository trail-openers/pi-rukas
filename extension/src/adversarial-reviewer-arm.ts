/**
 * #1978 — the two reviewer-arm decisions the adversarial loop makes about a
 * child that died, extracted so the loop keeps only the flow.
 *
 * Both are about the same object — the reviewer dispatch's `DispatchResult` —
 * and both exist because the shared machinery cannot own them:
 *
 *  - {@link projectReviewerKillCause} because `armBudget`'s `fired()` reports the
 *    minutes lever ONLY on a result whose `killCause` is `"child-bound"`
 *    (`lean/step-budget.ts`), and the loop's synthesised results carried none,
 *    so a reviewer the step's own `budgets.review.minutes` killed read as an
 *    ordinary verdict and the lean gate merged the head.
 *  - {@link classifyReviewer} because the shared classifier's `crashed` fallback
 *    retries a budget kill that arrived with no cause of its own, so one ceiling
 *    bought two reviewer children.
 *
 * Mirrors `capKillOrWatchdogKillCause` in `adversarial-retry.ts`.
 */

import { classifyDispatchOutcome } from "./adversarial-classify.ts";
import type { DispatchResult } from "./types.ts";

export type ReviewerClassification = ReturnType<typeof classifyDispatchOutcome>;

/**
 * The ONE cause that means "the caller's clock ended this child": the per-child
 * run bound the step armed. The caps-off shapes are deliberately NOT here:
 *
 *  - the turns / tokens levers need no projection of their own — a breach freezes
 *    `armBudget`'s `hit` (`lean/step-budget.ts`) and that frozen value is what the
 *    step reads, whether or not the child survived to report a cause;
 *  - `"abort"` is also how a PM / operator cancel is attributed (`spawn-kill-cause.ts`),
 *    so projecting it would let the step name the operator's ceiling for a child
 *    nothing in its budget stopped.
 *
 * The loop's cap kills (`loop` / `token-budget`) and the watchdog's provider-shaped
 * kills are NOT projected — those already reach the /work fan-out through
 * `infraFailureResult` with their own semantics, and here they would misreport an
 * infrastructure fault as a budget the operator set.
 */
const CALLER_CLOCK_CAUSES: readonly DispatchResult["killCause"][] = ["child-bound"];

export function projectReviewerKillCause(
  cause: DispatchResult["killCause"] | undefined,
): DispatchResult["killCause"] | undefined {
  return cause !== undefined && CALLER_CLOCK_CAUSES.includes(cause) ? cause : undefined;
}

/**
 * The reviewer's outcome, with the one arm the shared classifier must not own: a
 * budget-killed reviewer that carries NO cause of its own. That is the shape the
 * caps-off runtime leaves (`armChildBound` returns inert when `capsEnabled()` is
 * false), and `classifyDispatchOutcome`'s `crashed` fallback retries it.
 *
 * Kept out of the shared classifier because the four conditions below describe a
 * child the adversarial loop ended: it owns the controller the phase hands the
 * child, fed by the loop signal and the step's budget arms and nothing else. The
 * same test in the shared classifier would stop retrying every other caller's
 * crashed children. Every kill that carries a cause, and every provider fault,
 * still goes to `classifyDispatchOutcome` untouched.
 *
 * The cause it reports is {@link CRASHED_CAUSE} — `crashed` — and NOT
 * `self-killed:abort`: the child carried no kill cause, so naming it an abort
 * would attribute the death to a signal nothing recorded. What IS known is the
 * caller-side cancellation, and that is what the headline says.
 */
const CRASHED_CAUSE: ReviewerClassification["cause"] = "crashed";

export function classifyReviewer(r: DispatchResult): ReviewerClassification {
  const cls = classifyDispatchOutcome(r);
  if (cls.cause !== "crashed") return cls;
  if (r.errorStop !== undefined || r.killCause !== undefined) return cls;
  if (r.exitCode !== null && r.exitCode !== 0) return cls;
  if (r.text.trim() !== "") return cls;
  return {
    cause: CRASHED_CAUSE,
    shouldRetry: false,
    maxRetries: 0,
    headline:
      "ended with no verdict, no output and no fault by the caller's own cancellation (its budget arms or the loop's abort) — re-spawning would spend the ceiling again",
  };
}

/** The `killCause` spread for a synthesised result: absent unless the reviewer
 * child died of the caller's clock. */
export function synthKillCause(
  cause: DispatchResult["killCause"] | undefined,
): Pick<DispatchResult, "killCause"> | Record<string, never> {
  const projected = projectReviewerKillCause(cause);
  return projected === undefined ? {} : { killCause: projected };
}
