/**
 * lens-review-incomplete — the one question "did this review fail to cover the
 * diff?", asked by name (#1105).
 *
 * A review is incomplete when a lens is blocked (it could not run) or a lens
 * returned in silence (it produced neither findings nor a summary). That is the
 * same rule `computeVerdict` applies before it looks at findings, so the answer
 * here is exactly `computeVerdict([], lenses) === "REVIEW_INCOMPLETE"`, without
 * encoding that equivalence as a call with an empty findings list.
 */

import { lensProducedEvidence } from "./lens-review-format.ts";
import type { LensRunResult } from "./lens-review-types.ts";

/** True when any lens is blocked, or a lens produced no evidence of review. */
export function isReviewIncomplete(lensResults: readonly LensRunResult[] | undefined): boolean {
  return (lensResults ?? []).some((r) => !!r.blocked || !lensProducedEvidence(r));
}
