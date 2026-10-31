/**
 * lean/review-git — the git and worktree half of the `review` step.
 *
 * The step's other file owns WHEN the loop runs: which verdict ends it, what a
 * fix round is told, when the budget says stop. This file owns the only thing
 * that file cannot reason about from state alone — where the bytes are. A review
 * is a claim about a commit, so every read here resolves a ref to a sha, and
 * every write here is proven against the object database before origin sees it.
 *
 * Two invariants the caller depends on and cannot re-check:
 *
 * - **No read returns an empty string for "there is nothing".** A missing branch
 *   is a throw, never `""`, because `""` is also what a clean diff looks like and
 *   a review step that confuses the two approves code nobody looked at.
 * - **Nothing here moves origin except `integrate`, and nothing here is forced.**
 *   The fixer's tree is disposable and detached; the run's own tree is only the
 *   vehicle for a ref update. A concurrent push is refused by git rather than
 *   overwritten by us.
 *
 * All of it takes `ReviewDeps.exec`, so a test drives these claims against a real
 * temp repo without a model in the loop — which is the only way a claim like
 * "the frozen blob still hashes to its record" is a test rather than a comment.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { traceWarn } from "../trace.ts";
import type { DispatchResult, DispatchUsage } from "../types.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import { frozenMatches } from "./build-git.ts";
import type { HandlerCtx } from "./engine.ts";
import type { ReviewFixArgs } from "./review-prompt.ts";
import { fixPrompt } from "./review-prompt.ts";
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

/** Drop the disposable tree. A refusal there is not a failure of the step. */
async function removeWorktree(deps: ReviewDeps, repoRoot: string, wt: string): Promise<void> {
  await git(deps, repoRoot, ["worktree", "remove", "--force", wt]);
  // Prune the registration even when `remove` refused. `add` below rejects a
  // path whose registration is already taken and whose directory is gone — a
  // killed round leaves exactly that — and a path this step owns exclusively,
  // under a name no other code writes, is what makes the prune safe.
  await git(deps, repoRoot, ["worktree", "prune"]);
}

/**
 * The fixer's tree: created fresh, detached at the reviewed commit, provisioned,
 * and proven clean before the child is paid.
 *
 * The clean proof is the claim every lean step makes of a tree it is about to
 * hand a model: this worktree is this step's, so anything already in it is a
 * leftover from a killed round, and a leftover the child inherits becomes part of
 * what the integration moves onto the branch. `--force` is for this step's own
 * path only — `worktree remove` refuses a path it does not own, so no tree at
 * any other location is ever touched here.
 *
 * The clean proof is read WITHOUT `-uall`, and that is deliberate rather than
 * loose: `provisionWorktree` has just linked the project's dependency trees into
 * this directory, and `git status --porcelain -uall` expands a directory of
 * links into every file inside it (measured: `?? node_modules/pkg/j.js` for a
 * tree the provisioner made, with nothing in `git status`'s default view). A
 * proof that read it that way would report every provisioned tree as dirty and
 * refuse every fix round on the very step that prepares it. What the default
 * form still reports is enough for the claim being made: any untracked path — a
 * whole directory included — is listed, so a leftover from a killed round cannot
 * pass, and a child's edits to tracked files are listed too.
 */
async function fixTree(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  head: string,
  rows: DispatchUsageRow[],
): Promise<string> {
  const { repoRoot, issue } = ctx;
  const wt = path.join(repoRoot, ".worktrees", `lean-${issue}-fix`);
  const created = await git(deps, repoRoot, ["worktree", "add", "--force", "--detach", wt, head]);
  if (created === undefined)
    throw new ReviewInfraError(
      `could not create the fix worktree at ${wt} for ${head.slice(0, 12)}`,
      rows,
    );
  // No catch: `provisionWorktree` resolves whatever happens — every probe and git
  // call inside it turns a fault into a `problem` field rather than a rejection
  // (#1394, because a rejected provision used to fail the branch step) — so a
  // rejection-handling arm here would be code for a failure that cannot occur.
  // The `problem` it does report is traced and carried on: a bare or partly
  // linked tree costs the fixer a failed typecheck, not the run.
  const provision = await provisionWorktree(deps.exec, repoRoot, wt);
  if (provision.problem !== undefined)
    traceWarn(`lean review #${String(issue)}: fix worktree ${provision.problem}`);
  const dirty = await git(deps, wt, ["status", "--porcelain=v1"]);
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
  opts: ReviewFixArgs & { rows: DispatchUsageRow[] },
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
    rows: DispatchUsageRow[];
  },
): Promise<{ head: string }> {
  const wt = await fixTree(deps, ctx, opts.head, opts.rows);
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
  const fail = (why: string): never => {
    void restore(deps, wt, branch, opts.gateRead);
    throw new ReviewInfraError(why, opts.rows);
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
    return fail(
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
    return fail(
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
    return fail(
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
    return fail(`could not push the fix to origin/${branch}; the PR does not contain it`);
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

/**
 * Put the run's tree and its branch ref back at the commit the gates read.
 *
 * Best effort by design: it runs on a path that is already throwing, and a
 * second failure there would replace the reason the operator needs with a
 * complaint about the cleanup. A tree that is not even there is TRACED, never
 * assumed fixed — the ref move `integrate` made would otherwise be left behind
 * with nobody saying so.
 */
async function restore(deps: ReviewDeps, wt: string, branch: string, head: string): Promise<void> {
  if (!existsSync(wt)) {
    traceWarn(`lean review: ${wt} is gone, so ${branch} was left where the failed round put it`);
    return;
  }
  const back = await git(deps, wt, ["checkout", "-B", branch, head]);
  if (back === undefined)
    traceWarn(`lean review: could not put ${wt} back at ${head.slice(0, 12)}`);
}

/** One six-lens round's aggregate as a cost row; a round where nothing ran is not ok. */
export function lensRow(usage: DispatchUsage | undefined): DispatchUsageRow {
  return {
    role: "code-review-specialist",
    ms: 0,
    ok: usage !== undefined,
    usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  };
}
