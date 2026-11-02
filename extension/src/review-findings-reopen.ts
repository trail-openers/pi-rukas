/**
 * review-findings-reopen — the ONE way a stored row comes back from `resolved`
 * or `accepted` to `open` (#1934).
 *
 * Extracted from `review-findings-round.ts`, which sat at exactly the AGENTS.md
 * §12 500-line cap: this is the natural seam, a single total function every
 * reopen in a round goes through, and both the round and its untouched-row pass
 * already import from this directory's leaves.
 *
 * WHY IT IS WRITTEN FIELD-BY-FIELD AND NOT AS A SPREAD-AND-ASSERT.
 * `StoredFinding`'s `open` arm (review-findings-file.ts) declares
 * `resolvedReason?: undefined` and `confirmedBy?: undefined`: provenance is the
 * record of a CONFIRMED retirement, so an open row that keeps one is exactly the
 * stale-provenance state #1934 refuses to store. Spreading `r` and overwriting
 * only `status` type-checked BEFORE that arm closed and carried `confirmedBy`
 * through — a reopened row that still claimed a confirmation nobody had to
 * re-earn. Listing the fields is what makes the compiler refuse that: the first
 * version of this function written as `{ ...r, status: "open" }` failed
 * `tsc` with `Type 'string' is not assignable to type 'undefined'` on
 * `confirmedBy`, which is the rule asserting itself at the one write path rather
 * than living in a validator a caller can skip.
 */

import type { StoredFinding } from "./review-findings-file.ts";

/** The row with its retirement withdrawn: open again, no resolve reason, and no
 * provenance, so it is reported again and claims nothing it has not re-earned. */
export function reopen(r: StoredFinding): StoredFinding {
  return {
    ...r,
    status: "open",
    acceptance: undefined,
    resolvedReason: undefined,
    confirmedBy: undefined,
  };
}
