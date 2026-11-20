/**
 * lean/review-fix-tree — the fixer's own worktree: named for one round of one run, created detached,
 * provisioned, and proven clean before the child is paid.
 *
 * Split from `review-tree.ts` for the 500-line gate (AGENTS §12) along the file's own seam — the tree
 * this function builds is the one `fixRound` (`review-integrate.ts`) asks for and destroys, and it is
 * the only tree in the review step whose CLEANLINESS, not just whose existence, decides whether a fix
 * may be paid for. `review-tree.ts` keeps the rest of the disposable surface.
 */

import { traceWarn } from "../trace.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import type { HandlerCtx } from "./engine.ts";
import type { ReviewWave } from "./review-args.ts";
import { type FixArm, fixTreeName, removeWorktree } from "./review-tree.ts";
import type { FixRunId } from "./review.ts";
import { type ReviewDeps, ReviewInfraError } from "./review.ts";
import { gitQuiet } from "./specify-reset.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/**
 * The fixer's tree: created fresh, detached at the reviewed commit, provisioned, and proven clean
 * before the child is paid. The clean proof is the claim every lean step makes of a tree it is about to
 * hand a model: a leftover the child inherits becomes part of what moves onto the branch. `--force` is
 * for this step's own path only.
 *
 * **The path is unique to this round, so the claim is not a race.** With a per-round name, `add`
 * refusing a path it created for a round that never completed is the only collision left, and it is a
 * refusal rather than an adoption.
 *
 * The clean proof is read WITHOUT `-uall`: `provisionWorktree` has just linked the project's dependency
 * trees into this directory, and `-uall` expands a directory of links into every file inside it, so a
 * proof read that way would refuse every fix round. The default form still lists any untracked path.
 */
export async function fixTree(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  head: string,
  arm: FixArm,
  wave: ReviewWave,
  attempt: number,
  runId: FixRunId,
  rows: DispatchUsageRow[],
): Promise<string> {
  const { repoRoot, issue } = ctx;
  const wt = fixTreeName(repoRoot, issue, arm, wave, attempt, runId);
  // `add --force` is for THIS step's own path only, which is also why the name must be unique per
  // VISIT: `--force` makes collision with a path this step made itself a silent ADOPTION rather than
  // a refusal.
  const created = await gitQuiet(deps.exec, repoRoot, [
    "worktree",
    "add",
    "--force",
    "--detach",
    wt,
    head,
  ]);
  if (created === undefined)
    throw new ReviewInfraError(
      `could not create the fix worktree at ${wt} for ${head.slice(0, 12)} — a path this step names for this visit alone already exists, and adopting it would move somebody else's bytes onto the branch`,
      rows,
    );
  // Registered the moment the tree exists: `closeFixTrees` removes it, in this step's `finally`
  // whatever happens, and the refusal paths below remove it themselves before they throw.
  // No catch: `provisionWorktree` resolves whatever happens — every fault inside it becomes a
  // `problem` field rather than a rejection. A bare tree costs the fixer a failed typecheck, not the
  // run.
  const provision = await provisionWorktree(deps.exec, repoRoot, wt);
  if (provision.problem !== undefined)
    traceWarn(`lean review #${String(issue)}: fix worktree ${provision.problem}`);
  // Read AFTER provisioning and still a claim: the path is this round's alone, so anything git
  // reports here came from `add` or from the provisioner (whose links the default form does not list).
  const dirty = await gitQuiet(deps.exec, wt, ["status", "--porcelain=v1"]);
  if (dirty === undefined) {
    await removeWorktree(deps, repoRoot, wt);
    throw new ReviewInfraError(`could not read the fix worktree's state in ${wt}`, rows);
  }
  const left = dirty.stdout.split("\n").filter((s) => s.trim() !== "");
  if (left.length > 0) {
    await removeWorktree(deps, repoRoot, wt);
    throw new ReviewInfraError(
      `the fix worktree ${wt} is not clean before the fixer: ${left.slice(0, 8).join(", ")}`,
      rows,
    );
  }
  return wt;
}
