/**
 * lens-review-finish — the ONE exit path of the lens review (the #966
 * single-finish-path invariant), split from lens-review.ts (the 500-line
 * gate).
 *
 * `runLensReview` routes EVERY run shape through `finishLensReview`: it
 * writes the ledger entry (fire-and-forget — the write is a side effect,
 * never a gate on the result) and, on the one verdict that needs a post
 * (ISSUES_FOUND), posts the #973 residual-findings disclosure. #980 — the
 * branch arrives ALREADY RESOLVED (the shared `resolveReviewBranch` outcome
 * computed once in `runLensReview`), so the ledger write and the disclosure
 * marker key on the SAME branch string by construction; when it is undefined
 * the ledger write skips (traced) and the summary carries the VISIBLE
 * "disclosure NOT posted" note instead of the pre-#980 silent skip.
 */

import { writeLensLedgerEntry } from "./lens-ledger.ts";
import type { LensReviewSummary } from "./lens-review-format.ts";
import { postLensResidualDisclosure } from "./lens-review-residuals.ts";
import type { Severity } from "./lens-review.ts";

async function finish(
  summary: LensReviewSummary,
  threshold: Severity,
  cwd: string | undefined,
  branch: string | undefined,
  ledger: { hasCritical?: boolean; headSha?: string; head?: string } = {},
): Promise<LensReviewSummary> {
  void writeLensLedgerEntry(
    summary.verdict,
    threshold,
    cwd,
    branch,
    ledger.hasCritical,
    ledger.headSha,
    ledger.head,
  );
  // #973 — the residual-findings disclosure: posted ONLY when the verdict is
  // ISSUES_FOUND AND the branch's PR/MR resolves (see postLensResidual for
  // the trigger, the marker, and the fail-closed semantics). Awaited so the
  // tool result reports a failed post (the guard then refuses — fail closed)
  // before the summary is returned. #980 — the same VISIBLE rule applies
  // when the branch is unresolvable: the pre-#980 `&& branch` gate skipped
  // the post silently (the tool result was byte-identical to a successful
  // run). The note fires ONLY on ISSUES_FOUND (design decision 2).
  if (summary.verdict === "ISSUES_FOUND") {
    if (branch) {
      summary.note = await postLensResidualDisclosure({
        summary,
        branch,
        cwd: cwd ?? process.cwd(),
      });
    } else {
      summary.note =
        "Residual-findings disclosure NOT posted — no branch could be resolved for this review (detached head with no `branch` argument and no branch-named `head`), so no open PR/MR could be looked up. The merge guard's round-cap path will refuse until the marker is posted on the PR — run the review with an explicit `branch` (or on the branch's own checkout) and re-run.";
    }
  }
  return summary;
}

/** The ONE exit path — see the module header. */
export { finish as finishLensReview };
