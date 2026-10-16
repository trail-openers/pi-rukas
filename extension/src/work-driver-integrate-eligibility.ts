/**
 * #1240 — eligibility for skipping commit-pr's consolidated verify.
 *
 * `integrate()` step 4 runs the project's verify command against the
 * consolidated tree before the branch is pushed. For the shape below, that
 * tree is content the develop step already verified, so the run is duplicate
 * work — and on a slow project gate it is the most expensive duplicate in the
 * cycle.
 *
 * **The one eligible shape, and why each condition is load-bearing.**
 * `verifiedWorktree` is a claim the caller makes ("this is the workstream I
 * integrated"), not a proof; the conditions below are the proof.
 *
 * - `mode === "create"` — a followup integrates onto the branch's own tip,
 *   whose content no develop run ever judged.
 * - `ids.length === 1` — the combination of several workstreams genuinely is
 *   a tree nothing verified. (The caller only names a worktree at N=1 too;
 *   this check is what makes the seam safe if that ever changes.)
 * - `cherryApplied.length === 1` and `patchApplied.length === 0` — the work
 *   arrived as a cherry-picked commit. A patch transplant applies uncommitted
 *   content, which the develop run saw only if its index held it, so the
 *   trees need not agree.
 * - no `noDiff` entry — a workstream reported as contributing nothing means
 *   the integration is not the whole of what that worktree held.
 *
 * **The caller does not claim equality.** The returned pair is an *identity*
 * — this is the tree of that worktree, read from git. The seam
 * (`runCommitPrConsolidatedVerify`) compares it against the committed
 * integration tree and runs the command on any mismatch or read failure. The
 * rule can therefore be as strict as it likes and the run is still the
 * default; `undefined` here simply means "nothing to compare".
 *
 * Sibling of `developVerifiedTree` (work-driver-verify-eligibility.ts), which
 * governs the develop step's copy of the same duplicate run.
 */

import { verifyTreeId } from "./work-driver-verify-tree.ts";
import type { ExecFn } from "./worktree.ts";

export async function commitPrVerifiedTree(
  execFn: ExecFn,
  opts: {
    /** The worktree the caller claims it integrated (N=1 create-mode only). */
    verifiedWorktree: string | undefined;
    mode: "create" | "followup";
    ids: string[];
    cherryApplied: string[];
    patchApplied: string[];
    noDiff: Record<string, unknown>;
  },
): Promise<{ treeHash: string; worktree: string } | undefined> {
  const worktree = opts.verifiedWorktree;
  if (worktree === undefined) return undefined;
  const eligible =
    opts.mode === "create" &&
    opts.ids.length === 1 &&
    opts.cherryApplied.length === 1 &&
    opts.patchApplied.length === 0 &&
    Object.keys(opts.noDiff).length === 0;
  if (!eligible) return undefined;
  const treeHash = await verifyTreeId(execFn, worktree);
  // An unreadable tree is not an established identity: no identity, no skip.
  return treeHash === undefined ? undefined : { treeHash, worktree };
}
