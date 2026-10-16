/**
 * #1240 — the skip decision of the develop step's consolidated verify.
 *
 * `runConsolidatedVerify` builds a probe tree at repoRoot (checkout base,
 * cherry-pick each workstream's commits) and runs the project's verify
 * command against it. With one workstream whose own verify just passed, that
 * probe holds the same content the run above already judged, and the second
 * execution proves nothing (~21 min per pass on the tehas factory).
 *
 * The decision lives here rather than inline because it is the whole of the
 * safety argument for a change whose failure mode is "a gate silently stops
 * running", and the file that performs the probe is at the AGENTS.md §12 line
 * cap.
 *
 * **Why the comparison happens after the picks.** The tree that would be
 * verified only exists once the cherry-picks have landed. Deriving it from the
 * workstream's SHA beforehand is a guess for the worktree that holds
 * uncommitted work — the consolidation transplants that as a patch, not as a
 * commit, so SHA-equal worktrees can produce a different probe.
 *
 * **Why both sides are read, not one.** `verifyTreeId` reports the index tree
 * when the working tree is clean relative to the index and the HEAD tree
 * otherwise, and reports nothing at all when untracked or unstaged content
 * exists that no tree object describes. A side that cannot be read is not
 * "equal to anything" — it is unknown, and unknown runs the command.
 *
 * **The direction of the risk.** Every branch of this function that is not the
 * skip falls through to running the verify. A false skip means a gate did not
 * run; a false run costs minutes. So the function returns `undefined` unless
 * the comparison succeeded on both sides with real hashes.
 */

import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import { consolidatedVerifySkipEnabled, verifyTreeId } from "./work-driver-verify-tree.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * The skip to take for this probe, or `undefined` to run the verify command.
 *
 * `pending` is the identity the caller established for the worktree whose
 * per-worktree verify passed; `undefined` (the N>1, failed, or unreadable
 * case) means there is nothing to compare against and the run happens.
 */
export async function consolidatedVerifySkip(
  execFn: ExecFn,
  repoRoot: string,
  pending: AlreadyVerifiedTree | undefined,
): Promise<AlreadyVerifiedTree | undefined> {
  if (pending === undefined) return undefined;
  if (!consolidatedVerifySkipEnabled()) return undefined;
  const probeTree = await verifyTreeId(execFn, repoRoot);
  // The probe's own tree is unreadable: cannot prove equivalence, so run.
  if (probeTree === undefined) return undefined;
  // Equal hashes, both read successfully: the probe is the tree that passed.
  return probeTree === pending.treeHash ? pending : undefined;
}
