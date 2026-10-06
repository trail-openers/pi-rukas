/**
 * lens-review-branch-resolve — the #980 branch-resolution for the lens
 * review, split from lens-review.ts (the 500-line gate).
 *
 * `runLensReview` resolves the branch ONCE, synchronously-before-fan-out, via
 * the shared `resolveReviewBranch` helper (review-branch.ts): explicit
 * `branch` → a branch-named `head` ref (remote prefix stripped, ref must
 * exist) → `git rev-parse --abbrev-ref HEAD`. Every exit path (all five
 * `finish` calls and the noReview early return) keys the ledger write and
 * the residual-disclosure marker on this SAME value, and the "not recorded /
 * not posted" note (rendered when the branch is undefined) is derived from
 * the same resolution outcome (`branch` being undefined) — computed here
 * rather than by inspecting the fire-and-forget ledger file afterwards.
 */

import { execp } from "./lens-exec.ts";
import { resolveReviewBranch } from "./review-branch.ts";

export interface LensBranchResolution {
  /** The resolved branch (explicit → branch-named head → rev-parse). */
  branch: string | undefined;
  /** Where the branch came from (`head` is the branch-named-ref case). */
  source: "explicit" | "head" | "rev-parse" | "none";
}

/** Resolve the lens review's branch (see module header). */
export async function resolveLensReviewBranch(opts: {
  branch?: string;
  head?: string;
  cwd?: string;
}): Promise<LensBranchResolution> {
  const resolved = await resolveReviewBranch(
    { branch: opts.branch, head: opts.head, cwd: opts.cwd },
    execp,
  );
  return {
    branch: resolved.branch,
    source: resolved.source,
  };
}
