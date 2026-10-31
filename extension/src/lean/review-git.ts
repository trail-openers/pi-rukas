/**
 * lean/review-git — the ref-moving half of the review step's git surface, and
 * the fix round that produces the ref.
 *
 * `review.ts` is the decision procedure (WHEN the loop runs); `review-gates.ts`
 * adapts the two frozen review layers; `review-deps.ts` wires the outside world
 * and composes the briefs. This file owns the three things none of them can do
 * from where they sit: reading origin as the commit the gates review, reading
 * the diff they range over, and moving the run's branch onto the fixer's commits
 * — the only place in the whole step that touches origin.
 *
 * Two invariants the caller depends on and cannot re-check:
 *
 * - **No read returns an empty string for "there is nothing."** A missing branch
 *   is a throw, never `""`, because `""` is also what a clean diff looks like and
 *   a review step that confuses the two approves code nobody looked at. "git could
 *   not run" and "git found no such ref" are answered DIFFERENTLY, via
 *   `resolveHeadShaOutcome` — the resolver the frozen driver's own review path
 *   uses — because "the review cannot approve a head it cannot resolve" and "there
 *   is nothing to review" are different facts for an operator.
 * - **Nothing here is forced.** The fixer's tree is disposable and detached (see
 *   `review-tree.ts`); the run's own tree is only the vehicle for a ref update. A
 *   concurrent push is refused by git rather than overwritten by us.
 *
 * All of it takes `ReviewDeps.exec`, so a test drives these claims against a real
 * temp repo without a model in the loop — which is the only way a claim like "the
 * frozen blob still hashes to its record" is a test rather than a comment.
 */

import path from "node:path";
import { isFullCommitSha } from "../commit-sha.ts";
import { resolveHeadShaOutcome } from "../review-head-sha.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult } from "../types.ts";
import { netRefProblem } from "../work-driver-net-git.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import { frozenMatches } from "./build-git.ts";
import type { HandlerCtx } from "./engine.ts";
import { assertPublishableBranch } from "./publish-deps.ts";
import { type ReviewFixArgs, fixPrompt } from "./review-deps.ts";
import {
  type FixArm,
  closeFixTrees,
  fixTree,
  removeWorktree,
  restore,
  restoredSentence,
} from "./review-tree.ts";
import type { ReviewDeps } from "./review.ts";
import { FIX_BOUND_MS, type FixRunId, ReviewInfraError } from "./review.ts";
import { gitQuiet, resetWorktreeToBase } from "./specify-reset.ts";
import { assertSpecifyWorktreeOwned, specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { BudgetArms, BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import { FIXER_ROLE, dispatchUsageRow } from "./step-budget.ts";

/**
 * The commit this round reviews: origin's branch, as a full sha.
 *
 * A read that could not run and a branch that does not exist are both fatal and
 * are stated DIFFERENTLY: the first says the review cannot approve a head it
 * cannot resolve, the second says there is nothing to review. Neither reads as
 * "an empty diff, nothing to change" — that is an approval with no bytes behind
 * it, and it is the failure this step's whole shape exists to make impossible.
 * The split comes from `resolveHeadShaOutcome`, the resolver the frozen driver's
 * review path already uses, rather than a local `rev-parse` whose stderr and exit
 * code were discarded and both answers collapsed into one.
 */
export async function reviewedHead(
  deps: ReviewDeps,
  repoRoot: string,
  branch: string,
  rows: DispatchUsageRow[],
): Promise<string> {
  const ref = `origin/${branch}`;
  const outcome = await resolveHeadShaOutcome(repoRoot, ref, deps.exec);
  // Narrowed on `sha` first, so `failed` is only read on the arm that has it.
  if (outcome.sha !== undefined) {
    if (isFullCommitSha(outcome.sha)) return outcome.sha;
    // A resolver that printed something which is not an oid is "git found no such
    // commit", not "git could not be asked" — the shape rule is this step's.
    return await refused(ref, false, rows);
  }
  return await refused(ref, outcome.failed, rows);
}

/** The refusal for a head this step cannot review, worded by WHY it cannot. */
async function refused(ref: string, failed: boolean, rows: DispatchUsageRow[]): Promise<never> {
  throw new ReviewInfraError(
    failed
      ? `could not ask git what ${ref} is, so the review cannot approve a head it cannot resolve`
      : `${ref} is not a commit this clone has, so there is nothing to review — and nothing to review is not a pass`,
    rows,
  );
}

/**
 * The diff `base...head` as text.
 *
 * The step needs it for two reasons and pays for it once: the evidence builders
 * (`buildEvidence`, `runClaimScan`) cannot answer "could not read the branch"
 * differently from "found nothing", so the caller has to establish that the branch
 * is readable BEFORE asking them — and the way it establishes that is to read the
 * diff itself, which is the same range the lenses range over. `undefined` is the
 * only honest answer for a read that failed, and the caller turns it into a throw.
 */
export async function rangeDiff(
  deps: ReviewDeps,
  repoRoot: string,
  base: string,
  head: string,
  rows: DispatchUsageRow[],
): Promise<string | undefined> {
  const diff = await gitQuiet(deps.exec, repoRoot, ["diff", `${base}...${head}`]);
  if (diff === undefined) {
    throw new ReviewInfraError(
      `could not read the diff ${base}...${head.slice(0, 12)} for the six-lens pass`,
      rows,
    );
  }
  return diff.stdout;
}

/** One fixer, and the row it cost. */
async function runFixer(
  deps: ReviewDeps,
  opts: ReviewFixArgs & { rows: DispatchUsageRow[]; worktreeRunId: FixRunId },
): Promise<void> {
  let result: DispatchResult;
  // The budget arms are DESTRUCTURED rather than spread, for the one reason
  // `review-deps.ts` gives for the lens leg: spreading `opts.budget.opts` after
  // `childBoundMs: FIX_BOUND_MS` re-supplied the key and the budget's value WON,
  // which made this constant decoration. `arms` is what the fixer may inherit
  // (the abort signal and the progress hook) with the one key it must not own
  // taken out of the object AND out of the type, so a future spread that could
  // carry a `childBoundMs` is a compile error rather than a bug waiting for
  // someone to reorder the lines. Same shape as `review-deps.ts`'s lens seam —
  // one shape for this rule in the module, not a helper.
  const { childBoundMs: budgetBoundMs, ...arms } = opts.budget.opts;
  try {
    result = await deps.dispatch(
      { role: FIXER_ROLE, prompt: fixPrompt(opts), cwd: opts.worktree },
      {
        // The smaller of the step's own ceiling and the armed budget's: a budget
        // may only ever TIGHTEN the fixer's bound, never lengthen it, which is
        // what a budget has to mean for the most expensive child this step buys.
        childBoundMs: Math.min(FIX_BOUND_MS, budgetBoundMs ?? Number.POSITIVE_INFINITY),
        // The fixer is a developer with a worktree and a contract, which is what
        // `build`'s builder is too — so it gets the same fence. Without one a
        // fixer could write anywhere the process can write, and the whole
        // purpose of the fence (#1655) is the child that writes outside its
        // worktree. Same shape `BuildDispatch` passes: root, repo, and the run's
        // own scratch dir one level up from the worktree's parent.
        writeFence: {
          root: opts.worktree,
          repo: opts.repoRoot,
          scratch: path.join(
            path.dirname(opts.worktree),
            "..",
            "tmp",
            `lean-${String(opts.issue)}`,
          ),
        },
        // The step's budget's other arms: the abort the turns/tokens levers fire
        // and the progress hook that fires it. `childBoundMs` is the one arm taken
        // out above, so the spread cannot re-supply it.
        ...arms,
      },
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
  // The tree's identity rides in its OWN field (`runId`), validated with the row
  // by the loader. It used to ride by overwriting `ms` with a 13-digit epoch,
  // which cost the fixer its only duration, made the row refusable by
  // `isMeasure` (and so silently dropped, under-billing the step's most expensive
  // child), let the row cap evict the row that carried the id, and forced the
  // reader to identify the row by the generic `developer` role — the builder's
  // role as well. `ms` is the child's real duration again.
  row.runId = opts.worktreeRunId;
  opts.rows.push(row);
  // The step's own ceiling ending the fixer is a VERDICT, read before the infra
  // throw below would have called it a dead child.
  const fired = opts.budget.fired(result);
  if (fired !== undefined) {
    opts.stop.fired = fired;
    return;
  }
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
 * What a fix round hands back: the head now on origin, or the budget's verdict
 * when the step's own ceiling stopped the fixer. `stop` is optional on both arms
 * so the caller narrows on one field rather than on a union of two shapes.
 */
export type FixRoundOutcome = { head?: string; stop?: BudgetFired };

/**
 * One fix round: the child in its disposable tree, then its commits moved onto the
 * branch.
 *
 * `visit` counts fix-tree CREATIONS for this step, and the caller owns it: the
 * tree's name must be unique per dispatch, and a review round dispatches a fixer
 * on two arms, so no per-round number can serve (see `fixTreeName`). `runId` is
 * the caller's, not this round's: the same value has to name the tree for the
 * whole round, and a run identity a test can predict is the difference between
 * driving the collision path and merely hoping not to hit it.
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
    arm: FixArm;
    attempt: number;
    runId: FixRunId;
    rows: DispatchUsageRow[];
    budget: BudgetArms;
  },
): Promise<FixRoundOutcome> {
  // The tree's whole name is derived from the durable run — arm, round, attempt
  // and the attempt's epoch — so a resume of this attempt recomputes the same
  // path and re-enters the tree its killed self left (see `fixTreeName`). No
  // counter of ours is involved, because a counter would restart at zero there.
  const treeSuffix = `${opts.arm}-${String(opts.round)}-${String(opts.attempt)}`;
  const wt = await fixTree(
    deps,
    ctx,
    opts.head,
    opts.arm,
    opts.round,
    opts.attempt,
    opts.runId,
    opts.rows,
  );
  let fixHead = "";
  const stop: { fired?: BudgetFired } = {};
  try {
    await runFixer(deps, {
      issue: ctx.issue,
      round: opts.round,
      gate: opts.gate,
      findings: opts.findings,
      worktree: wt,
      repoRoot: ctx.repoRoot,
      branch: specifyBranch(ctx.run.branch, ctx.issue),
      base: ctx.run.baseSha,
      head: opts.head,
      frozenPaths: Object.keys(opts.frozen),
      rows: opts.rows,
      worktreeRunId: `${String(opts.runId)}-${treeSuffix}` as FixRunId,
      budget: opts.budget,
      stop,
    });
    if (stop.fired !== undefined) return { stop: stop.fired };
    // Read BEFORE the tree is destroyed: what the child's last commit IS is the
    // one value the integration acts on, and once `worktree remove` has run
    // there is no commit left to ask about. A child that committed nothing
    // leaves the head exactly where this step put it, which the identity claim
    // in `integrate` then proves rather than the step assuming a commit occurred.
    const fix = await gitQuiet(deps.exec, wt, ["rev-parse", "HEAD"]);
    fixHead = (fix?.stdout ?? "").trim();
  } finally {
    await removeWorktree(deps, ctx.repoRoot, wt);
  }
  return await integrate(deps, ctx, {
    gateRead: opts.head,
    fixHead,
    frozen: opts.frozen,
    rows: opts.rows,
  });
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
): Promise<FixRoundOutcome> {
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
  // The push target is state-file data, so it gets `publish`'s guard BEFORE the
  // first mutating git operation: `resetWorktreeToBase` below moves the run's
  // branch with `-B` and cleans its tree, which mutates the one tree `verify`
  // and `publish` read next. `assertSafeRef` alone only proves the name is a
  // LEGAL git ref, and `main` is legal — so this, the second writer to origin in
  // the pipeline, reused `publish`'s own decision rather than writing a third
  // validator. Its documented fail-open for a clone with no `origin/HEAD` and no
  // `gh` is kept as-is: an unresolvable mainline is ordinary, and refusing every
  // fix push on it would be a new failure mode, not a tighter guard.
  await assertPublishableBranch(repoRoot, branch).catch((err: unknown) => {
    throw new ReviewInfraError((err as Error)?.message ?? String(err), opts.rows);
  });
  if (!isFullCommitSha(opts.fixHead))
    throw new ReviewInfraError(
      `the fix round reported no commit to integrate (${JSON.stringify(opts.fixHead.slice(0, 40))})`,
      opts.rows,
    );
  // Bring the run's own branch to the fixer's head. This is NOT
  // `ensureSpecifyWorktreeWithProvision`: that path resets the branch with `-B`
  // back at the base it was given, which would point the branch straight back at
  // the reviewed commit and throw the fixer's work away before the push ever saw
  // it (a previous commit on this branch had to be reverted for exactly that).
  // The tree is only the vehicle for a ref update here, so the ownership claim
  // runs first (it is what refuses a tree another run owns) and the move happens
  // by reset, which also drops any uncommitted sloppiness the child left behind.
  try {
    await assertSafeRef(branch);
    await assertSpecifyWorktreeOwned(deps.exec, {
      repoRoot,
      wt,
      baseSha: opts.gateRead,
      branch,
    });
    // The one primitive `specify` and `build` use for this, called directly: the
    // five-line `ensureFixTree` wrapper that used to sit here added a name for
    // nothing. `resetWorktreeToBase` does the `-B`, the `--hard`, the `clean` and
    // the proof the tree really got there, pointed at the fixer's head.
    await resetWorktreeToBase(deps.exec, wt, opts.fixHead, branch);
  } catch (err) {
    return await fail(
      `the run's worktree ${wt} is not usable for the fix round: ${(err as Error)?.message ?? String(err)}`,
    );
  }
  // `resetWorktreeToBase` cleans with `-fdx`, which takes the dependency links
  // the provisioner made. Re-provision AFTER the reset rather than reaching for
  // the `ensureSpecifyWorktreeWithProvision` variant that provisions too: that
  // variant also resets the branch, and the fixer's commit is on it. Provisioning
  // here is what `build` and `verify` need from a tree they are about to read —
  // a `node_modules` that `clean -fdx` deleted and nothing rebuilt is a verify
  // that fails for the shape of the tree, not for the diff.
  const provision = await provisionWorktree(deps.exec, repoRoot, wt);
  if (provision.problem !== undefined)
    traceWarn(
      `lean review #${String(issue)}: run worktree after the fix reset — ${provision.problem}`,
    );
  // The one claim the step cannot make from origin after the fix tree is gone is
  // that the head it is about to push is a head THIS step created. Proven against
  // the object database, which outlives the tree: the fixer's head is either the
  // commit this step checked out for it (the child committed nothing, so the
  // round was a no-op) or a descendant of it (the child committed on top). A
  // child that reset, rebased or checked something else out fails here, before
  // origin sees any of it. Checked for the no-op case too: `--is-ancestor X X`
  // is true, so the same one probe proves the child left the tree where this step
  // put it rather than checking something else out and calling that a no fix.
  const ancestor = await gitQuiet(deps.exec, repoRoot, [
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
  //
  // It is also the only git call in this step that leaves the clone, so it is the
  // one the seam gives the driver's non-interactive env to — the same `netGitEnv`
  // `publish`'s executor applies (#1095: `GIT_TERMINAL_PROMPT=0` plus
  // `-o BatchMode=yes`, so ssh fails instead of reading a passphrase from
  // /dev/tty and hanging the step). Every other call here is local.
  //
  // The name is checked with the driver's own `netRefProblem` immediately before
  // the argv is built — the placement `publish`'s `pushHead` uses (#1095). It
  // reads the same charset `assertPublishableBranch` applied above, so this is
  // NOT the guard — deleting it alone keeps every refusal in
  // `test-lean-review-push-guards.ts` green, because the earlier call refuses the
  // same names first. It is the check that sits beside the command line it
  // protects, so an edit that MOVES or drops the earlier one cannot silently put a
  // refspec (`a:b`), a force (`+x`) or an option (`-f`) — all of which
  // `assertSafeRef` calls legal — in front of a network git call. The case that
  // proves that layering is (x1)"s "refused before the worktree was touched"
  // assertion, which goes red the moment `assertPublishableBranch` is removed.
  const unsafe = netRefProblem(`refs/heads/${branch}`);
  if (unsafe !== undefined) return await fail(`refusing to push ${branch}: ${unsafe}`);
  const pushed = await gitQuiet(deps.exec, wt, [
    "push",
    "origin",
    `refs/heads/${branch}:refs/heads/${branch}`,
  ]);
  if (pushed === undefined)
    return await fail(`could not push the fix to origin/${branch}; the PR does not contain it`);
  return { head: opts.fixHead };
}
