/**
 * lean/review-entry — the checks a `review` step refuses BEFORE it pays for
 * anything, and nothing else.
 *
 * `review.ts` is the decision procedure (WHEN the loop runs) and had grown the
 * entry gate into its own body. That is a size accident with a real cause: the
 * gate is a different kind of thing from the loop. The loop's refusals are
 * verdicts about the WORK under review; these four refusals are about whether the
 * step may start at all — is the ref it will push a legal name, is it a name this
 * step is allowed to push, is the base a commit at all. Each asks one question of
 * state-file data and each answers before a child is dispatched, a tree is created
 * or a ref is moved. A leaf module like `review-errors.ts`, so the fixtures and
 * the step share one definition of the shape rather than agreeing by coincidence.
 *
 * **Placement is the contract, and it is the reason this file exists.** The gate
 * used to sit inside `review-git.ts`'s `integrate()`, which runs AFTER
 * `resetWorktreeToBase` (`checkout -B` moves the run's branch, `reset --hard` drops
 * its commits, `clean -fdx` takes the tree and the provisioner's dependency links
 * with it) and after the fixer dispatch. So a hostile state-file name did its
 * damage before the refusal, and the restore that follows can itself fail and
 * report a clean tree that is not clean. It is also why the cheap `netRefProblem`
 * stays where it is: the two checks are two layers, and the layering — plus the
 * mutation that proves the ordering is real — is stated at the push site in
 * `review-git.ts`.
 *
 * `assertPublishableBranch` is `publish`'s own decision, REUSED rather than a third
 * validator written for the review push. Its FAIL-CLOSED mainline rule travels with
 * it: a clone that cannot read its own `origin/HEAD` and has no `gh` no longer skips
 * the rule, it gets asked of origin over the transport this step's own push uses, and
 * a mainline neither will name refuses the push. `exec` is the step's executor for
 * that reason — a guard that probed on a different seam than the push would be
 * answered by a different machine than the one it is protecting. Pinned by
 * `test-lean-review-push-guards.ts` (x3), which now asserts the refusal, and by
 * `test-lean-guard-fail-closed-callers.ts` (r1)/(r2), which assert this step's own
 * exec is the seam asked.
 */

import { isFullCommitSha } from "../commit-sha.ts";
import type { MainlineExecFn } from "../probe-cause.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { assertPublishableBranch } from "./publish-deps.ts";
import { ReviewInfraError } from "./review-errors.ts";

/**
 * Refuse a run this step must not start, before any child is paid.
 *
 * Called ONCE per attempt from the top of `reviewOutcome`, not per gate: the
 * mainline resolution spawns two subprocesses (`resolveMainline` reads
 * `origin/HEAD`, then `gh repo view`) and one step asks the question four times
 * over (two gate passes and the re-review's), so calling it beside each of them
 * would buy eight subprocesses to re-ask a question whose answer cannot change
 * while the step runs.
 *
 * The `branch` handed in is already the derived push target
 * (`specifyBranch(run.branch, issue)`), i.e. state-file data rather than a name
 * this cycle chose — which is the whole reason it gets `publish`'s guard and not
 * just `assertSafeRef`. Throws `ReviewInfraError` with no `rows`: this is the
 * step's first event and nothing has been dispatched, so the empty default is the
 * whole truth rather than a dropped cost record.
 */
export async function assertReviewEntry(opts: {
  repoRoot: string;
  branch: string;
  base: string;
  exec: MainlineExecFn;
}): Promise<void> {
  const { repoRoot, branch, base, exec } = opts;
  // Legality first: a name git will not accept as a ref is refused before anything
  // is asked of the network, and `base` gets the same treatment because the diff
  // range is built from it.
  try {
    assertSafeRef(branch);
    if (base !== "") assertSafeRef(base);
  } catch (err) {
    throw new ReviewInfraError((err as Error).message);
  }
  if (!isFullCommitSha(base))
    throw new ReviewInfraError(
      `the run has no base commit to review against: ${JSON.stringify(base.slice(0, 80))}`,
    );
  // Publishability second: legality does not make a name PUSHABLE (`main` is legal,
  // and `+x` is legal and reads as a force), so this is the half `review` never had
  // while `publish` had it all along.
  try {
    await assertPublishableBranch(repoRoot, branch, exec);
  } catch (err) {
    throw new ReviewInfraError((err as Error).message);
  }
}
