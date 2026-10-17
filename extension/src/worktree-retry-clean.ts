/**
 * worktree-retry-clean — #1391: make a worktree clean for a retry WITHOUT
 * destroying what the lost attempt left in it.
 *
 * The failure this closes (tehas cycles 109 / 60): a step child is lost
 * mid-stream, the driver classifies the failure and re-runs the step — and the
 * fresh child immediately meets the tree the dead one left behind. At 109 the
 * lens-fix retry's own precondition read the severed attempt's half-written
 * files as operator dirt (`lens-fix-reposition: worktree has uncommitted
 * changes: …`), parked the cycle, and recorded a third "review round" that
 * lasted one second. Nothing committed, stashed, or discarded what the
 * severed child left, because no such seam existed.
 *
 * This module is that seam, and it is a *composition*, not a new recipe:
 *
 *  - the save + guarded reset is `resetWorktreeToBase` (work-develop-git.ts),
 *    the #1016 primitive the develop fan-out already trusts: it refuses unless
 *    the path is inside `<repoRoot>/.worktrees/` and the base is a 40-hex SHA,
 *    it saves every uncommitted path as a binary patch (`wx` — never
 *    clobbering an earlier save) BEFORE `reset --hard` + `clean -fd`, and it
 *    never touches a worktree with commits ahead of base;
 *  - the loss judgement is `inspectWorktreeForLoss` (worktree-loss.ts), the
 *    #475/#1170 rule for "what a destructive git op would destroy": tracked
 *    and untracked edits always, ignored trees only when they are not a
 *    regenerable dependency directory, and an unreadable read counted as loss.
 *
 * Preserve-then-clean, fail-closed: a dirt the primitives refuse to discard
 * (unpushed commits, an unreadable status or diff) is PRESERVED in place and
 * reported as a non-clean outcome. This module never escalates to a force
 * remove and never deletes a commit — removing a worktree is a different
 * seam's job (`salvageDirtyWorktree` + `worktreeRemove`). Its only destructive
 * calls are the ones `resetWorktreeToBase` already vets.
 *
 * Callers own the consequence: the step router (task B) decides what a
 * non-clean retry means for its step. This seam's contract is only "nothing
 * is lost; the answer is honest".
 */

import path from "node:path";
import { trace } from "./trace.ts";
import {
  type ExecFn,
  commitsAheadOfBase,
  errText,
  isValidBaseSha,
  nextRetryAttempt,
  resetWorktreeToBase,
  retryPatchPath,
  runGit,
} from "./work-develop-git.ts";
import {
  type DirtyWorktreeFinding,
  type ExecFn as WorktreeExecFn,
  inspectWorktreeForLoss,
} from "./worktree.ts";

/** A dirty worktree is worth preserving when it holds something git cannot
 *  recover: an uncommitted file (not in the object database — the #475 rule)
 *  or a commit the base does not have. HEAD-equals-base with a clean tree has
 *  nothing to preserve, and an `inspectError` means the state is unknown —
 *  unknown is NOT dirty, so nothing is tagged or reset over it. */
export function retryTreeWorthPreserving(finding: DirtyWorktreeFinding): boolean {
  return finding.uncommittedFiles.length > 0 || finding.unpushedCommitCount > 0;
}

/** What one clean attempt did. */
export interface RetryCleanOutcome {
  /** The worktree name (basename of its path), for the trace/retry line. */
  worktree: string;
  /** True when the worktree is provably clean afterwards — nothing left for a
   *  precondition guard to mistake for operator dirt.
   *  `clean === true && !noop` means the dirty tree the retry would otherwise
   *  have met has been saved to `patch` and reset away. */
  clean: boolean;
  /** True when there was nothing to preserve (already clean at the base). */
  noop: boolean;
  /** Saved-diff path when uncommitted work was saved and reset away. */
  patch?: string;
  /** Why the tree is NOT clean afterwards, or why it was not touched. */
  reason?: string;
}

/**
 * Preserve then clean one worktree for a retry.
 *
 * Order is load-bearing: preserve FIRST, and every branch that could not
 * preserve refuses the destructive part.
 *
 *  1. Inspect (#475 rule). Unreadable → touch nothing.
 *  2. Nothing to preserve → `noop` (a reset would only burn the provisioned
 *     dependency links for no gain).
 *  3. Commits ahead of base → do NOT reset (the develop path's rule: a
 *     worktree with commits is never reset — history is integrated, not
 *     discarded). The commits and any dirt stay exactly as they are and the
 *     outcome says so; removing or tagging a worktree is a different seam's
 *     job (`salvageDirtyWorktree` + `worktreeRemove`).
 *  4. Otherwise → `resetWorktreeToBase`: it saves every uncommitted path to
 *     the retry patch before discarding anything, then `reset --hard` +
 *     `clean -fd` (sparing `.pi/` and `tmp/`). A refused save throws and is
 *     reported as not-clean — never as clean.
 *
 * Every git failure is swallowed into `clean: false` with a `reason`: a clean
 * that could not run is the status quo (the tree stays dirty), not a loss.
 */
export async function cleanWorktreeForRetry(args: {
  execFn: ExecFn;
  repoRoot: string;
  worktreePath: string;
  /** The cycle's base SHA (40-hex) — the state the retry should start from. */
  base: string | undefined;
  /** The cycle's scratch dir (`<repoRoot>/tmp/issue-<N>`), where patches land. */
  scratchAbs: string;
}): Promise<RetryCleanOutcome> {
  const { execFn, repoRoot, base, scratchAbs } = args;
  const wt = path.resolve(args.worktreePath);
  const name = path.basename(wt);
  const notClean = (reason: string, extra: Partial<RetryCleanOutcome> = {}): RetryCleanOutcome => ({
    worktree: name,
    clean: false,
    noop: false,
    reason,
    ...extra,
  });

  let finding: DirtyWorktreeFinding | undefined;
  try {
    // `base` doubles as the loss-inspection ref: work ahead of it is "unpushed".
    // The two ExecFn spellings are structurally identical, so the cast is a
    // naming artifact of the two modules, not a widening.
    finding = await inspectWorktreeForLoss(
      execFn as unknown as WorktreeExecFn,
      repoRoot,
      wt,
      base ?? "HEAD",
    );
  } catch (err) {
    return notClean(`inspect failed: ${errText(err)}`);
  }
  if (finding?.inspectError !== undefined) {
    return notClean(`worktree unreadable, untouched: ${finding.inspectError}`);
  }
  if (!finding || !retryTreeWorthPreserving(finding)) {
    return { worktree: name, clean: true, noop: true };
  }

  const git = runGit(execFn);
  if (!isValidBaseSha(base)) {
    return notClean("base is not a 40-hex sha, untouched");
  }

  const ahead = await commitsAheadOfBase(git, wt, base);
  if (!("commits" in ahead)) {
    return notClean(`commit count unreadable, untouched: ${ahead.unreadable}`);
  }
  if (ahead.commits > 0) {
    return notClean(`${ahead.commits} commit(s) ahead of base — preserved in place, not reset`);
  }

  // Uncommitted work only: save (fail-closed) then reset. `retryPatchPath`
  // validates the worktree name as a plain path component and keeps the patch
  // inside `scratchAbs`; a step retries more than once, so the attempt is the
  // next free number in the scratch dir and the write (`wx`) never clobbers an
  // earlier save.
  let patchPath: string;
  try {
    const attempt = await nextRetryAttempt(scratchAbs, name);
    patchPath = retryPatchPath(scratchAbs, name, attempt);
  } catch (err) {
    return notClean(`patch path refused: ${errText(err)}`);
  }
  try {
    const patch = await resetWorktreeToBase(git, wt, base, { repoRoot, patchPath });
    trace(
      `worktree-retry-clean: ${name} cleaned for retry${patch ? ` — diff saved to ${patch}` : ""}`,
    );
    return { worktree: name, clean: true, noop: false, patch };
  } catch (err) {
    return notClean(`reset refused — work preserved in place: ${errText(err)}`);
  }
}
