/**
 * #1240 — the skip decision of the commit-pr consolidated verify.
 *
 * `runCommitPrConsolidatedVerify` runs the project's verify command against
 * the integration branch's committed tree at repoRoot. When the cycle has one
 * workstream and the integration is that worktree's content and nothing else,
 * this is the tree the develop step already verified green
 * (`developVerifiedTree` / `consolidatedVerifySkip` are the develop step's
 * copies of the same rule).
 *
 * **Why the read happens after the caller has committed.** At this seam the
 * tree under verification is HEAD's *committed* tree, so the comparison has to
 * be taken against what HEAD holds now — not against a SHA captured earlier,
 * which would be a claim about a tree that may not be checked out.
 *
 * **Why `git write-tree` is part of the read and not just `HEAD^{tree}`.**
 * If the index still holds something the commit does not (residue staged and
 * then left uncommitted), the verify command would judge content the develop
 * gate never saw. `verifyTreeId` reports the index tree whenever the index
 * differs from HEAD, so residue makes the two sides disagree and the run
 * happens. An index that cannot be written at all is likewise not an
 * established identity.
 *
 * **The direction of the risk is the same as the develop step's:** every
 * branch that is not the exact, both-sides-read equality falls through to
 * running the command.
 */

import { trace } from "./trace.ts";
import { consolidatedVerifySkipEnabled, verifyTreeId } from "./work-driver-verify-tree.ts";
import type { ExecFn } from "./worktree.ts";

export type AlreadyVerifiedTree = { treeHash: string; worktree: string };

export async function commitPrSkipDecision(
  execFn: ExecFn,
  repoRoot: string,
  pending: AlreadyVerifiedTree | undefined,
): Promise<AlreadyVerifiedTree | undefined> {
  if (pending === undefined) return undefined;
  if (!consolidatedVerifySkipEnabled()) return undefined;
  const integrationTree = await verifyTreeId(execFn, repoRoot);
  if (integrationTree !== undefined && integrationTree === pending.treeHash) {
    trace(
      `work-driver: commit-pr — consolidated verify skipped: tree ${integrationTree} already passed in ${pending.worktree}`,
    );
    return pending;
  }
  // Not a duplicate — worth a line, because the alternative reading of a fast
  // commit-pr is "did it skip, or was it just quick?"
  trace(
    `work-driver: commit-pr — verifying the consolidated tree (tree ${integrationTree ?? "unreadable"} is not the tree that passed in ${pending.worktree})`,
  );
  return undefined;
}
