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

import { isFullCommitSha } from "../commit-sha.ts";
import { resolveHeadShaOutcome } from "../review-head-sha.ts";
import { traceWarn } from "../trace.ts";
import { netRefProblem } from "../work-driver-net-git.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import { frozenMatches } from "./build-git.ts";
import type { HandlerCtx } from "./engine.ts";
import type { ReviewWave } from "./review-args.ts";
import type { ReviewFixArgs } from "./review-deps.ts";
import { foldFix, runFixer } from "./review-fix-child.ts";
import {
  type FixArm,
  closeFixTrees,
  fixTree,
  removeWorktree,
  restore,
  restoredSentence,
} from "./review-tree.ts";
import type { ReviewDeps } from "./review.ts";
import { type FixRunId, ReviewInfraError } from "./review.ts";
import { gitQuiet, resetWorktreeToBase } from "./specify-reset.ts";
import { assertSpecifyWorktreeOwned, specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { BudgetArms, BudgetFired, DispatchUsageRow } from "./step-budget.ts";

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
  // Both bounds are resolved to commits before the range is asked for. `base` and
  // `head` reach here as strings the step did not mint (a ledger-resolved delta
  // base, a head the layer recorded), and a range whose bound does not name a
  // commit is indistinguishable, in this read, from a range with no changes — so
  // the ambiguity is removed here rather than passed down: an unresolvable bound
  // is a failed read, and the caller turns a failed read into a throw.
  const from = await resolveCommitArg(deps, repoRoot, base);
  const to = await resolveCommitArg(deps, repoRoot, head);
  if (from === undefined || to === undefined)
    throw new ReviewInfraError(
      `could not resolve the range ${base.slice(0, 12)}...${head.slice(0, 12)} for the six-lens pass (${from === undefined ? `\`${base}\`` : `\`${head}\``} is not a commit this clone has) — a range nobody can name is not a diff to review`,
      rows,
    );
  const diff = await gitQuiet(deps.exec, repoRoot, ["diff", `${from}...${to}`]);
  if (diff === undefined) {
    throw new ReviewInfraError(
      `could not read the diff ${base}...${head.slice(0, 12)} for the six-lens pass`,
      rows,
    );
  }
  return diff.stdout;
}

/** One range bound as a commit this clone has, or undefined when it is not one. */
async function resolveCommitArg(
  deps: ReviewDeps,
  repoRoot: string,
  rev: string,
): Promise<string | undefined> {
  if (rev.trim() === "") return undefined;
  const out = await gitQuiet(deps.exec, repoRoot, ["rev-parse", "--verify", `${rev}^{commit}`]);
  const sha = (out?.stdout ?? "").trim();
  return isFullCommitSha(sha) ? sha : undefined;
}

/**
 * What a fix round hands back: the head now on origin, or the budget's verdict
 * when the step's own ceiling stopped the fixer. `stop` is optional on both arms
 * so the caller narrows on one field rather than on a union of two shapes.
 */
export type FixRoundOutcome = { head?: string; stop?: BudgetFired };

/**
 * One fix wave: the child in its disposable tree, then its commits moved onto the
 * branch.
 *
 * The step dispatches exactly one fixer, so `wave` and `arm` are constants of a
 * step rather than loop counters — they are kept because the tree's NAME must be
 * reproducible from the durable run (see `fixTreeName`), and the name is what a
 * resumed attempt re-enters. `runId` is the caller's, not this round's: the same
 * value has to name the tree for the whole wave, and a run identity a test can
 * predict is the difference between driving the collision path and merely hoping
 * not to hit it.
 *
 * The head it returns is the head now on origin, read back from git rather than
 * assumed from what the child reported doing. The row the child cost is appended
 * to `opts.rows` by `runFixer` — success and death — so this function never
 * touches it; the budget's verdict keeps precedence over the fold, since a
 * fixer the step's own ceiling killed is the stop the operator armed.
 */
export async function fixRound(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    head: string;
    frozen: Record<string, string>;
    findings: string;
    /** The run's issue, printed into the fixer's brief (see `ReviewFixArgs`). */
    issueBody: string;
    gate: string;
    wave: ReviewWave;
    arm: FixArm;
    attempt: number;
    runId: FixRunId;
    rows: DispatchUsageRow[];
    budget: BudgetArms;
  },
): Promise<FixRoundOutcome> {
  // The tree's whole name is derived from the durable run — arm, wave, attempt
  // and the attempt's epoch — so a resume of this attempt recomputes the same
  // path and re-enters the tree its killed self left (see `fixTreeName`). No
  // counter of ours is involved, because a counter would restart at zero there.
  const treeSuffix = `${opts.arm}-${opts.wave}-${String(opts.attempt)}`;
  const wt = await fixTree(
    deps,
    ctx,
    opts.head,
    opts.arm,
    opts.wave,
    opts.attempt,
    opts.runId,
    opts.rows,
  );
  const stop: { fired?: BudgetFired } = {};
  try {
    await runFixer(deps, {
      issue: ctx.issue,
      wave: opts.wave,
      gate: opts.gate,
      findings: opts.findings,
      // The step's one issue body, threaded to the renderer: `fixRound` is handed
      // it and `runFixer` prints it, so a call site that dropped it would leave
      // the fixer judging the findings against nothing but the findings.
      issueBody: opts.issueBody,
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
    // The step's own ceiling ending the fixer is a VERDICT, read before anything
    // else the round reports, so the fold below cannot capture a partial child.
    if (stop.fired !== undefined) return { stop: stop.fired };
    return await integrate(deps, ctx, {
      gateRead: opts.head,
      fixHead: await foldFix(deps, ctx, wt, {
        head: opts.head,
        frozen: opts.frozen,
        attempt: opts.attempt,
        rows: opts.rows,
      }),
      frozen: opts.frozen,
      rows: opts.rows,
    });
  } finally {
    await removeWorktree(deps, ctx.repoRoot, wt);
  }
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
  // The push target was already refused at the STEP ENTRY POINT —
  // `reviewOutcome` calls `publish`'s `assertPublishableBranch` beside its
  // `assertSafeRef`, before a child is paid or a tree is touched. It is deliberately
  // NOT re-asked here: it spawns two subprocesses to resolve the mainline, the
  // answer cannot change while a step runs, and this function is called once per
  // fix round. What stays here is the cheap charset check beside the argv it
  // protects, below.
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
  // reads the same charset the entry-point `assertPublishableBranch` applied before
  // this step paid for anything, so this is NOT the guard — deleting it alone keeps
  // every refusal in `test-lean-review-push-guards.ts` green, because the earlier
  // call refuses the same names first. It is the check that sits beside the command
  // line it protects, so an edit that MOVES or drops the entry-point one cannot
  // silently put a refspec (`a:b`), a force (`+x`) or an option (`-f`) — all of
  // which `assertSafeRef` calls legal — in front of a network git call. The case
  // that proves that layering is (x1)'s "refused before anything mutated" assertion
  // (no `checkout -B`, no `reset --hard`, no `clean -fdx`, no `worktree add` in the
  // recorded argv), which goes red the moment the entry-point call is moved back to
  // after the first mutating git call — verified by performing that move.
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
