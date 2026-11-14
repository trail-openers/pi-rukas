/**
 * lens-review-head-sha — the ONE head identity a lens round writes to the
 * ledger, resolved before any early return (#1039).
 *
 * The ledger matches a round against a PR head OID by string equality, so a bare
 * branch name reaching that field corrupts the round-cap comparison: a later
 * round cannot tell "already reviewed at this head" from "never reviewed", which
 * is how a capped review loop keeps re-running rounds it already spent. The
 * shape check below is what keeps that invariant on every exit path rather than
 * on the happy one.
 *
 * It is a module rather than lines in `lens-review.ts` because the rule is a
 * shape rule about a field, and the run function that needs it is already the
 * orchestration of six children, a budget and a ledger write. The rule is a
 * discrimination over `ReviewDiffOutcome`, so that is the type it takes: a
 * structural stand-in (`kind: string`) would let a new `ok` variant carrying its
 * head outside `delta` compile and silently resolve `headRef ?? "HEAD"` — a
 * wrong-but-plausible head in the ledger, which is the defect class #1039 closed.
 */

import type { ReviewDiffOutcome } from "./lens-review-diff.ts";
import { isFullCommitSha, resolveHeadSha } from "./review-head-sha.ts";
import { trace } from "./trace.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";

/** The shared exec seam (`execp`), the same one `resolveHeadSha` takes. */
export type HeadExec = VerifyExecFn;

/**
 * The head this round reviewed, or nothing when the round reviewed no commit.
 *
 * `undefined` is a real answer, not a gap: the blocked and no-review exits have
 * no head, the ledger write omits the field, and a later round-cap check fails
 * closed on its absence. A malformed value is worse than an absent one, which is
 * why a non-SHA delta head is dropped (and traced) instead of written.
 */
export async function resolveRoundHeadSha(
  resolved: ReviewDiffOutcome,
  cwd: string,
  headRef: string | undefined,
  exec: HeadExec,
): Promise<string | undefined> {
  if (resolved.kind !== "ok") {
    // blocked or noReview: no commit was reviewed, so there is no head to name.
    return undefined;
  }
  if (resolved.delta) {
    // The delta arm's head is normally already a full SHA — `resolveDeltaDiff`
    // resolves it through the shared resolver — but that resolver falls back to
    // the raw caller ref on a git failure, and the fallback must not be written.
    if (isFullCommitSha(resolved.delta.head)) return resolved.delta.head;
    trace(
      `lens-review: delta head ${resolved.delta.head.slice(0, 40)} is not a 40-char SHA — headSha omitted (the round-cap check fails closed on the absent field)`,
    );
    return undefined;
  }
  // The full-review arm resolves the caller's head ref (or HEAD) through the
  // shared resolver; an unresolvable ref leaves the field absent, same rule.
  return resolveHeadSha(cwd, headRef ?? "HEAD", exec);
}
