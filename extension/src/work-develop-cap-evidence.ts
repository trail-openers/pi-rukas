/**
 * work-develop-cap-evidence — #841: the bounded cap-hit evidence for a develop
 * fan-out's failures. Split out of work-develop-topological.ts (500-line gate).
 *
 * A failure string is already an 800-char attributed tail; a fanout with
 * several failures joined unboundedly produced multi-KB evidence. Each failure
 * and the join itself are bounded, with a truncation marker so the operator
 * knows the evidence is bounded.
 */
import { extractAttributedTail } from "./work-driver-exec-error.ts";

const CAP_EVIDENCE_PER_FAILURE_MAX = 800;
const CAP_EVIDENCE_TOTAL_MAX = 4000;
const CAP_EVIDENCE_TRUNCATED = " … (truncated)";

/** #841 — bound a single failure string before it is joined into evidence. */
function boundFailure(f: string): string {
  return extractAttributedTail(f, CAP_EVIDENCE_PER_FAILURE_MAX).tail || f.slice(-800);
}

/** #841 — join bounded failures, capping the total with a truncation marker. */
export function boundJoinFailures(failures: string[]): string {
  const joined = failures.map(boundFailure).join(" | ");
  if (joined.length <= CAP_EVIDENCE_TOTAL_MAX) return joined;
  return joined.slice(0, CAP_EVIDENCE_TOTAL_MAX) + CAP_EVIDENCE_TRUNCATED;
}
