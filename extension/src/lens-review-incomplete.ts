/**
 * lens-review-incomplete — the one question "did this review fail to cover the
 * diff?", asked by name (#1105).
 *
 * A review is incomplete when a lens is blocked (it could not run) or a lens
 * returned in silence (it produced neither findings nor a summary). Both
 * `computeVerdict` (lens-review-format.ts) and the driver's callers ask this
 * function, so the rule exists once. The evidence rule lives here too, so this
 * module imports nothing and cannot form a cycle with the format module.
 */

import type { LensRunResult } from "./lens-review-types.ts";

/** What `spawn-collapse-events.ts` substitutes for a reply that was all thinking. */
export const NO_TEXT_PLACEHOLDER = "(thinking content only - no text output)";

/**
 * Did a (possibly cap-killed) child produce ANY review evidence — findings
 * or a non-placeholder closing summary. Shared by `lensProducedEvidence` and the
 * cap-kill branch in lens-review-child.ts, so a `(thinking content only - no
 * text output)` placeholder never counts as a summary in either path.
 */
// `collapseEvents` substitutes NO_TEXT_PLACEHOLDER when a child produced only
// thinking blocks. It is a placeholder describing the absence of output, not
// output — counting it as a summary would let the exact silence this guards
// against slip through wearing the right shape.
export function hasReviewEvidence(findings: unknown[], summary?: string): boolean {
  if (findings.length > 0) return true;
  const s = summary?.trim();
  if (!s) return false;
  return s !== NO_TEXT_PLACEHOLDER;
}

/**
 * Did this lens actually review anything?
 *
 * A lens that reported a finding plainly did. A lens that reported none is
 * only credible if it also wrote the closing summary the prompt asks for.
 * Neither means the child produced nothing at all — wrong model, dropped
 * reporter extension, exhausted context, or a bare "ok" — and that is
 * indistinguishable from a careful review right up until it is treated as one.
 *
 * `blocked` covers the lens that FAILED. This covers the lens that succeeded
 * at saying nothing, which is the harder case because it looks like success.
 */
export function lensProducedEvidence(r: LensRunResult): boolean {
  return hasReviewEvidence(r.findings, r.summary);
}

/** True when any lens is blocked, or a lens produced no evidence of review. */
export function isReviewIncomplete(lensResults: readonly LensRunResult[] | undefined): boolean {
  return (lensResults ?? []).some((r) => !!r.blocked || !lensProducedEvidence(r));
}
