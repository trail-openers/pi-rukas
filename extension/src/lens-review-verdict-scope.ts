/**
 * lens-review-verdict-scope — the rows a SCOPED re-review's verdict is computed
 * from (#1537), split from `lens-review-findings.ts` for the AGENTS.md §12
 * 500-line gate (the same seam as `lens-review-findings.ts` itself).
 *
 * One function, and it changes only the VERDICT's input. The summary, the
 * severity counts, the fixer's blob and the residual disclosure all still read
 * the full reported list from `resolveReportedFindings`, so a demoted finding is
 * disclosed, never deleted — a row the policy declined to fix is exactly the row
 * an operator should see on the PR.
 *
 * The rules it enforces, and why each is drawn the way it is:
 *
 *  - a row the findings store carried (`isCarried`) is still OPEN and keeps
 *    blocking at its own severity: the round saw it, did not resolve it, and its
 *    cited code is unchanged, so a fix pass that ignored a finding cannot pass;
 *  - a row the round REPORTED is new to this round and nothing in the fix wave
 *    was asked to answer it, so it blocks only when CRITICAL. A fresh MEDIUM on
 *    code the first review already read is the noise the policy exists to stop —
 *    measured on this repo, three MEDIUMs cost three six-lens reviews and ~96
 *    finding rows on a +4/-12 diff, none of them CRITICAL or HIGH;
 *  - `REVIEW_INCOMPLETE` is never rewritten: that verdict is about the REVIEW (a
 *    lane never answered), not about the findings, and demoting it would turn a
 *    five-pass into a six-pass — standing doctrine;
 *  - a project whose bar sits ABOVE `BLOCKING_SEVERITY` has said sub-HIGH rows
 *    never block, and the narrowing must not make the harness stricter than the
 *    project's own doctrine: such a round keeps its own verdict.
 */

import { atOrAboveThreshold, type Severity } from "./lens-review-format.ts";
import { isReviewIncomplete } from "./lens-review-incomplete.ts";
import { BLOCKING_SEVERITY } from "./lens-review-policy.ts";
import { type Finding, isCarried, type LensRunResult } from "./lens-review-types.ts";

/**
 * The rows the verdict is computed from. `reported` is the blocking half of the
 * round as `resolveReportedFindings` produced it (post-memory, post-operator
 * decision, post-advisory split) and is returned UNCHANGED whenever the round is
 * not a scoped re-review — an ordinary first round is judged entirely by the
 * project's bar, and `scoped` arrives from `lensPolicyOf`, not from a counter.
 *
 * Fail-closed on trust: `scoped` is honoured only for a review every lane
 * answered. A delta or an incomplete round has no trustworthy carried rows, so
 * everything it reported blocks — this repo's standing shape for "the evidence
 * needed to relax a rule is not present".
 */
export function reportedForVerdict(
  reported: Finding[],
  lensResults: readonly LensRunResult[],
  threshold: Severity,
  scoped: boolean,
): Finding[] {
  if (!scoped || isReviewIncomplete(lensResults)) return reported;
  const carried = reported.filter(isCarried);
  const freshCritical = reported.filter((f) => f.severity === "CRITICAL" && !isCarried(f));
  const blocking = [...carried, ...freshCritical];
  if (!atOrAboveThreshold(BLOCKING_SEVERITY, threshold)) {
    // A CRITICAL-only bar: keep the round's own answer rather than adding rows
    // that bar would never have blocked.
    return reported.some((r) => atOrAboveThreshold(r.severity, threshold)) ? reported : blocking;
  }
  return blocking;
}
