/**
 * work-driver-lens-fix-identity — which half of the review fix loop a dispatch
 * belongs to, and the step name its traces print.
 *
 * A leaf split from `work-driver-lens-fix-budget.ts` for the AGENTS.md §12
 * 500-line gate: the arming module (`work-driver-lens-fix-arming.ts`) and the
 * budget module both name a fixer in their traces, and two spellings of the
 * same step name in two files is how a log stops being greppable.
 */

/** Which half of the fix loop armed this bound. `reviewFixDispatchBoundMs` is
 *  called with `step: "lens-fix"` for BOTH of them (the lens-fix dispatch and
 *  the adversarial develop fix pass — `work-develop-run.ts`), because the
 *  second inherits the lens-fix bound by design. So the caller that owns the
 *  dispatch STATES its identity; it is never inferred from
 *  `pipelineState.currentStep`, which is whatever the last step left there — a
 *  develop fix pass dispatched straight after a lens-fix read as `lens-fix`
 *  and its traces named the wrong step. */
export type FixerIdentity = "lens-fix" | "develop-fix-pass";

/** The identity the adversarial develop fix pass declares (its call site spells
 *  `step: "lens-fix"`, so naming the fixer is what keeps the trace honest). */
export const FIXER_DEVELOP_PASS: FixerIdentity = "develop-fix-pass";

/** The step name a fixer trace carries, from the identity its caller declared. */
export function fixerStepName(fixer: FixerIdentity): string {
  return fixer === "develop-fix-pass" ? "develop (fix pass)" : "lens-fix";
}
