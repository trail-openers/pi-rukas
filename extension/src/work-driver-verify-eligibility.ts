/**
 * #1240 — the eligibility rule for skipping the develop step's consolidated
 * verify.
 *
 * The develop gate verifies twice per pass: once per changed worktree, then
 * once more against a probe tree the consolidated run builds at repoRoot by
 * cherry-picking each workstream's commits onto the cycle's base. With ONE
 * workstream whose per-worktree verify just passed, that probe is base + the
 * same commits, i.e. the content the run above already judged — a second
 * full gate for nothing (measured on a slow project gate: ~21 min per pass,
 * roughly a third of the cycle).
 *
 * The rule lives here, away from the gate that consults it, because what it
 * decides is worth reading on its own and the gate file is at the §12 line
 * cap. The commit-pr twin of this seam is `commitPrVerifiedTree` in
 * `work-driver-integrate-eligibility.ts`.
 *
 * Two things this deliberately does NOT do:
 *
 * - **It does not decide to skip.** It returns an identity; the probe compares
 *   that identity against the tree it actually built, after the picks, and
 *   runs the command on any mismatch or read failure. Deciding from a SHA
 *   before the picks would be guessing.
 * - **It does not trust a caller's word about the worktree.** The identity is
 *   read from git here, and `undefined` — no identity, no skip — is the
 *   result of any failure, including a worktree path that no longer exists.
 */

import type { DriverContext } from "./work-driver-context.ts";
import type { AlreadyVerifiedTree } from "./work-driver-verify-tree.ts";
import { consolidatedVerifySkipEnabled, verifyTreeId } from "./work-driver-verify-tree.ts";
import type { ExecFn } from "./worktree.ts";

export async function developVerifiedTree(
  /** Raw executor: never the fast-tier wrapper — see the note below. */
  execFn: ExecFn,
  ctx: DriverContext,
  opts: {
    /** Worktrees the per-worktree loop above actually ran a green verify on. */
    changedWorktrees: string[];
    /** Every workstream's worktree, including ones that produced no diff. */
    worktrees: Record<string, string | undefined>;
    /** Failures from the per-worktree loop — any one of these forbids a skip. */
    perWorktreeVerifyFailures: unknown[];
  },
): Promise<AlreadyVerifiedTree | undefined> {
  if (!consolidatedVerifySkipEnabled()) return undefined;
  if (opts.perWorktreeVerifyFailures.length > 0) return undefined;
  if (Object.keys(opts.worktrees).length !== 1) return undefined;
  if (opts.changedWorktrees.length !== 1) return undefined;
  const worktree = opts.changedWorktrees[0];
  // The one worktree that ran must be the one the probe combines — otherwise
  // the comparison would describe a tree the probe does not hold. This also
  // excludes the N=1 degenerate shape (the one worktree IS repoRoot): the
  // loop never runs there, so there is no green to reuse, and the probe's
  // dirty-root refusal still fires as before #1240.
  if (worktree === undefined || !Object.values(opts.worktrees).includes(worktree)) {
    return undefined;
  }
  // The read uses the RAW executor, not the fast-tier wrapper `execFn` is:
  // `withFastTier` intercepts by command TEXT, so identity must never put a
  // fast-tier run ahead of the very comparison that decides whether to run
  // anything. Git reads take no verify slot either, so they cannot consume a
  // permit.
  const gitRead: NonNullable<DriverContext["verifyExecFn"]> = ctx.verifyExecFn ?? execFn;
  const treeHash = await verifyTreeId(gitRead, worktree);
  return treeHash === undefined ? undefined : { treeHash, worktree };
}
