/**
 * lean/review-git — the ref-moving half of the `review` step's git surface.
 *
 * The step's decision procedure (`review.ts`) owns WHEN the loop runs; the
 * disposable trees (`review-tree.ts`) own where the fixer works. This file owns
 * the two things neither can do from its own position: reading origin as the
 * commit the gates review, and moving the run's branch onto the fixer's commits
 * — which is the only place in the whole step that touches origin.
 *
 * Two invariants the caller depends on and cannot re-check:
 *
 * - **No read returns an empty string for "there is nothing".** A missing branch
 *   is a throw, never `""`, because `""` is also what a clean diff looks like and
 *   a review step that confuses the two approves code nobody looked at.
 * - **Nothing here is forced.** The fixer's tree is disposable and detached; the
 *   run's own tree is only the vehicle for a ref update. A concurrent push is
 *   refused by git rather than overwritten by us.
 *
 * All of it takes `ReviewDeps.exec`, so a test drives these claims against a real
 * temp repo without a model in the loop — which is the only way a claim like
 * "the frozen blob still hashes to its record" is a test rather than a comment.
 */

import { traceWarn } from "../trace.ts";
import type { DispatchResult } from "../types.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { frozenMatches } from "./build-git.ts";
import type { HandlerCtx } from "./engine.ts";
import type { ReviewFixArgs } from "./review-prompt.ts";
import { fixPrompt } from "./review-prompt.ts";
import { fixTree, removeWorktree, restore, restoredSentence } from "./review-tree.ts";
import type { ReviewDeps } from "./review.ts";
import { FIX_BOUND_MS, ReviewInfraError } from "./review.ts";
import { NO_HOOKS, resetWorktreeToBase } from "./specify-reset.ts";
import { assertSpecifyWorktreeOwned, specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { DispatchUsageRow } from "./step-budget.ts";
import { dispatchUsageRow } from "./step-budget.ts";

/** git in `cwd` as an argv command; `undefined` when git refused rather than said no. */
async function git(
  deps: ReviewDeps,
  cwd: string,
  argv: string[],
): Promise<{ stdout: string } | undefined> {
  try {
    const r = await deps.exec("git", {
      argv: [...NO_HOOKS, ...argv],
      cwd,
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: r.stdout ?? "" };
  } catch {
    return undefined;
  }
}

/**
 * The commit this round reviews: origin's branch, as a full sha.
 *
 * A read that could not run and a branch that does not exist are both fatal and
 * are stated differently: the first says the review cannot approve a head it
 * cannot resolve, the second says there is nothing to review. Neither reads as
 * "an empty diff, nothing to change" — that is an approval with no bytes behind
 * it, and it is the failure this step's whole shape exists to make impossible.
 */
export async function reviewedHead(
  deps: ReviewDeps,
  repoRoot: string,
  branch: string,
  rows: DispatchUsageRow[],
): Promise<string> {
  const out = await git(deps, repoRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `origin/${branch}^{commit}`,
  ]);
  // `execp` does not throw on a non-zero exit, so "git said no" and "git could
  // not run at all" reach here identically, and this step treats them alike:
  // without a commit there is nothing to review, and nothing to review is never
  // a pass. The trace tells the two apart for the operator without changing what
  // the step does.
  const sha = (out?.stdout ?? "").trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    traceWarn(
      `lean review: origin/${branch} resolved to nothing (${out === undefined ? "git could not run" : "git found no such ref"})`,
    );
    throw new ReviewInfraError(
      `origin has no ${branch}, so there is nothing to review — and nothing to review is not a pass`,
      rows,
    );
  }
  return sha;
}

/** The diff `base...head` as text, for the lens pass and the evidence builders. */
export async function rangeDiff(
  deps: ReviewDeps,
  repoRoot: string,
  base: string,
  head: string,
  rows: DispatchUsageRow[],
): Promise<string> {
  const diff = await git(deps, repoRoot, ["diff", `${base}...${head}`]);
  if (diff === undefined)
    throw new ReviewInfraError(
      `could not read the diff ${base}...${head.slice(0, 12)} for the six-lens pass`,
      rows,
    );
  return diff.stdout;
}

/**
 * One fixer, and the row it cost.
 *
 * A child that died is infrastructure and throws with its rows attached, the same
 * rule `build` and `challenge` follow: the tokens were spent whether or not
 * anybody received a result, and a handback that cannot say so understates what
 * the run cost.
 */
async function runFixer(
  deps: ReviewDeps,
  opts: ReviewFixArgs & { rows: DispatchUsageRow[]; worktreeRunId: string },
): Promise<void> {
  let result: DispatchResult;
  try {
    result = await deps.dispatch(
      { role: "developer", prompt: fixPrompt(opts), cwd: opts.worktree },
      { childBoundMs: FIX_BOUND_MS },
    );
  } catch (err) {
    throw new ReviewInfraError(
      `the fix child could not be started: ${(err as Error)?.message ?? String(err)}`,
      opts.rows,
    );
  }
  // Billed BEFORE the verdict is read, and billed once: a child that died still
  // spent its tokens, and a handback that cannot say so understates what the run
  // cost. The row goes onto the caller's running total here rather than being
  // returned — a total the caller re-derives per round is how a handback ends up
  // reporting one round's cost as the step's, and returning it on the success arm
  // while appending the death arm's copy is how one fixer gets billed twice.
  const row = dispatchUsageRow(result);
  // The tree's run id travels home in `ms`, which is the one numeric field the
  // outcome validator admits (`isMeasure` in `state-outcome.ts`) and the reason
  // `fixRunId` yields a plain integer rather than a base36 string. It overwrites
  // the child's own duration on purpose: a fixer's wall clock is not what anyone
  // reads — the per-lens rows carry the timings that matter — while the id is
  // what lets a RESUMED attempt re-enter the tree the crashed one left behind
  // (see `fixRunIdFromLog`). The fixer is the only row that carries one.
  row.ms = Number(opts.worktreeRunId);
  opts.rows.push(row);
  if (!result.ok || result.killCause !== undefined || result.errorStop !== undefined) {
    const why =
      result.killCause ??
      result.errorStop?.message ??
      result.errorStop?.reason ??
      `exit ${String(result.exitCode)}`;
    throw new ReviewInfraError(`the fix child failed: ${String(why)}`, opts.rows);
  }
}

/**
 * One fix round: the child in its disposable tree, then its commits moved onto the
 * branch.
 *
 * `runId` is the caller's, not this round's: the same value has to name the tree
 * for the whole round, and a run identity a test can predict is the difference
 * between driving the collision path and merely hoping not to hit it.
 *
 * The head it returns is the head now on origin, read back from git rather than
 * assumed from what the child reported doing. The row the child cost is appended
 * to `opts.rows` by `runFixer`, on both arms — success and death — so this
 * function never touches it.
 */
export async function fixRound(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    head: string;
    frozen: Record<string, string>;
    findings: string;
    gate: string;
    round: number;
    runId: string;
    rows: DispatchUsageRow[];
  },
): Promise<{ head: string }> {
  const wt = await fixTree(deps, ctx, opts.head, opts.round, opts.runId, opts.rows);
  let fixHead = "";
  try {
    await runFixer(deps, {
      issue: ctx.issue,
      round: opts.round,
      gate: opts.gate,
      findings: opts.findings,
      worktree: wt,
      branch: specifyBranch(ctx.run.branch, ctx.issue),
      base: ctx.run.baseSha,
      head: opts.head,
      frozenPaths: Object.keys(opts.frozen),
      rows: opts.rows,
      worktreeRunId: opts.runId,
    });
    // Read BEFORE the tree is destroyed: what the child's last commit IS is the
    // one value the integration acts on, and once `worktree remove` has run
    // there is no commit left to ask about. A child that committed nothing
    // leaves the head exactly where this step put it, which the identity claim
    // in `integrate` then proves rather than the step assuming a commit occurred.
    const fix = await git(deps, wt, ["rev-parse", "HEAD"]);
    fixHead = (fix?.stdout ?? "").trim();
  } finally {
    await removeWorktree(deps, ctx.repoRoot, wt);
  }
  const pushed = await integrate(deps, ctx, {
    gateRead: opts.head,
    fixHead,
    frozen: opts.frozen,
    rows: opts.rows,
  });
  return { head: pushed };
}

/**
 * The fixer's commits, moved onto the run's branch and pushed.
 *
 * Four claims, all stated against the same pair of shas, before origin is
 * touched: the tree belongs to this run; the fixer's head is the commit this step
 * handed it or a descendant of it (a child that reset or rebased has rewritten
 * history the run did not write); the run's own worktree is this run's tree on
 * this run's branch at that commit; and every frozen blob at the fixer's head
 * still hashes to its record.
 *
 * A push that does not land is refused rather than retried — the alternative is a
 * run whose PR silently lacks the fix its review round was paid for. Every refusal
 * puts the tree back at the reviewed commit first, so a handback never leaves a
 * half-integrated branch checked out where `verify` and `publish` will look next.
 * "First" is awaited, not fired: the restore has to have run before the throw,
 * and its outcome is named in the cause, because "the tree is back where the gates
 * read it" and "the tree is still at the fixer's head" are different facts for an
 * operator about to run `verify`.
 */
async function integrate(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    gateRead: string;
    fixHead: string;
    frozen: Record<string, string>;
    rows: DispatchUsageRow[];
  },
): Promise<string> {
  const { repoRoot, issue } = ctx;
  const branch = specifyBranch(ctx.run.branch, issue);
  // The run's OWN worktree — never the fixer's, which no longer exists here.
  const wt = specifyWorktreePath(repoRoot, issue);
  // Awaited BEFORE the throw, and its outcome folded into the cause. A fire-and-
  // forget restore here (the `void` this had) races the throw on the next line,
  // so the handback was emitted while the tree was mid-move and a restore that
  // failed printed a warning to a trace no operator reads — leaving a branch
  // checked out at the fixer's head with nothing in the cause saying so. Same
  // class as #1449/#984, where the equivalent fire-and-forget was given a
  // reporter rather than silence.
  const fail = async (why: string): Promise<never> => {
    const undone = await restore(deps, wt, branch, opts.gateRead);
    throw new ReviewInfraError(`${why}${restoredSentence(undone, wt, opts.gateRead)}`, opts.rows);
  };
  try {
    assertSafeRef(branch);
  } catch (err) {
    throw new ReviewInfraError((err as Error).message, opts.rows);
  }
  if (!/^[0-9a-f]{40}$/.test(opts.fixHead))
    throw new ReviewInfraError(
      `the fix round reported no commit to integrate (${JSON.stringify(opts.fixHead.slice(0, 40))})`,
      opts.rows,
    );
  // Bring the run's own branch to the fixer's head. This is NOT
  // `ensureSpecifyWorktreeWithProvision`: that path re-provisions a tree nobody
  // is about to build in (this step runs no verify command) and, worse, resets
  // the branch with `-B` — which would point it straight back at the reviewed
  // commit and throw the fixer's work away before the push ever saw it. The tree
  // is only the vehicle for a ref update here, so the ownership claim runs first
  // (it is what refuses a tree another run owns) and the move happens by reset,
  // which also drops any uncommitted sloppiness the child left behind it.
  try {
    await assertSpecifyWorktreeOwned(deps.exec, {
      repoRoot,
      wt,
      baseSha: opts.gateRead,
      branch,
    });
    await ensureFixTree(deps, wt, branch, opts.fixHead);
  } catch (err) {
    return await fail(
      `the run's worktree ${wt} is not usable for the fix round: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  // The one claim the step cannot make from origin after the fix tree is gone is
  // that the head it is about to push is a head THIS step created. Proven against
  // the object database, which outlives the tree: the fixer's head is either the
  // commit this step checked out for it (the child committed nothing, so the
  // round was a no-op) or a descendant of it (the child committed on top). A
  // child that reset, rebased or checked something else out fails here, before
  // origin sees any of it. Checked for the no-op case too: `--is-ancestor X X`
  // is true, so the same one probe proves the child left the tree where this step
  // put it rather than checking something else out and calling that a no fix.
  const ancestor = await git(deps, repoRoot, [
    "merge-base",
    "--is-ancestor",
    opts.gateRead,
    opts.fixHead,
  ]);
  if (ancestor === undefined)
    return await fail(
      `the fixer's head ${opts.fixHead.slice(0, 12)} does not descend from the ${opts.gateRead.slice(0, 12)} this step checked out for it`,
    );
  // `frozenMatches` rather than a probe of this file's: the frozen record is a
  // sha256 of the committed BYTES, so the only comparison that means anything is
  // `git show <ref>:<path>` re-hashed — an object-id read (e.g. `rev-parse
  // <ref>:<path>`) is a sha1 of a different thing and matches nothing, which
  // would refuse every fix round that ever committed. Same proof `build` and
  // `verify` apply, so the three cannot disagree about what a frozen file is.
  const broken = await frozenMatches(deps.exec, repoRoot, opts.fixHead, opts.frozen);
  if (broken.length > 0)
    return await fail(
      `the fix round changed the frozen acceptance contract: ${broken.slice(0, 6).join(", ")}`,
    );
  // The push is deliberately NOT forced: a branch somebody else moved while the
  // fixer ran is refused by git itself rather than rewritten here, which is the
  // whole guarantee this step needs and needs from the one component that
  // actually holds the truth about what origin holds. Reading origin first would
  // buy nothing — that read is stale the moment it returns.
  const pushed = await git(deps, wt, [
    "push",
    "origin",
    `refs/heads/${branch}:refs/heads/${branch}`,
  ]);
  if (pushed === undefined)
    return await fail(`could not push the fix to origin/${branch}; the PR does not contain it`);
  return opts.fixHead;
}

/**
 * Move the run's branch (and the tree that has it checked out) to `head`.
 *
 * The same primitive `specify` and `build` use — `resetWorktreeToBase` does the
 * `-B`, the `--hard` and the proof the tree really got there — pointed at the
 * fixer's head instead of a base, so uncommitted mess the child left behind it
 * cannot ride into the push. No clean and no re-provisioning: this step runs no
 * verify command, so nothing in it needs a dependency tree.
 */
async function ensureFixTree(
  deps: ReviewDeps,
  wt: string,
  branch: string,
  head: string,
): Promise<void> {
  await resetWorktreeToBase(deps.exec, wt, head, branch);
}
