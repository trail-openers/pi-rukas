/**
 * lean/review-integrate — the fixer's commits, moved onto the run's branch and pushed.
 *
 * `review-git.ts` reads origin and reads the diff; this file is the fix ROUND —
 * the disposable tree, the fixer's one child and its one continuation, and the push that leaves the
 * clone. `FixRoundOutcome` stays declared where the round's reader narrows on it (`review-git.ts`
 * exports the type; both halves of the round import it from there).
 *
 * Every git call is argv form through `ReviewDeps.exec`, and the child goes through the deps' seams,
 * so a test drives the whole round against a real temp repo with no model in the loop.
 */
import { isFullCommitSha } from "../commit-sha.ts";
import { traceWarn } from "../trace.ts";
import { cycleChildOpts } from "../work-cycle-trust.ts";
import { netRefProblem } from "../work-driver-net-git.ts";
import { assertSafeRef } from "../worktree-loss.ts";
import { provisionWorktree } from "../worktree-provision.ts";
import { frozenMatches } from "./build-git.ts";
import type { HandlerCtx } from "./engine.ts";
import type { ReviewWave } from "./review-args.ts";
import { askTruncatedFixer, foldFix, runFixer } from "./review-fix-child.ts";
import { fixTree } from "./review-fix-tree.ts";
import { type FixArm, removeWorktree } from "./review-tree.ts";
import type { FixRunId } from "./review.ts";
import type { DerivedSpec } from "./state-derived-spec.ts";
import type { BudgetArms } from "./step-budget.ts";

import { restore, restoredSentence } from "./review-tree.ts";
import type { ReviewDeps } from "./review.ts";
import { ReviewInfraError } from "./review.ts";
import { gitQuiet, resetWorktreeToBase } from "./specify-reset.ts";
import { type SubmoduleNote, submoduleNoteClause } from "./specify-submodules.ts";
import { assertSpecifyWorktreeOwned, specifyBranch, specifyWorktreePath } from "./specify-tree.ts";
import type { BudgetFired, DispatchUsageRow } from "./step-budget.ts";

/**
 * What a fix round hands back: the head now on origin, or the budget's verdict when the step's
 * own ceiling stopped the fixer. `stop` is optional on both arms so the caller narrows on one
 * field rather than a union of two shapes. `submodules` is the integration's own clause and
 * `reverted` the fold's — what it undid — both present only when there was something to say,
 * and both handed up because the caller owns the step's reason: a wave that answered its
 * findings while quietly un-doing part of the fix is what the `reverted:` clause discloses.
 */
export type FixRoundOutcome = {
  head?: string;
  stop?: BudgetFired;
  submodules?: string;
  reverted?: string[];
  /** See `askTruncatedFixer`: the wave spent its ONE continuation on a cut-off fixer. */
  truncated?: boolean;
};

/**
 * The fixer's commits, moved onto the run's branch and pushed.
 *
 * Four claims, all stated against the same pair of shas, before origin is
 * touched: the tree belongs to this run; the fixer's head is the commit this step
 * handed it or a descendant of it; the run's own worktree is this run's tree on
 * this run's branch at that commit; and every frozen blob at the fixer's head still
 * hashes to its record.
 *
 * A push that does not land is refused rather than retried — the alternative is a
 * run whose PR silently lacks the fix its review round was paid for. Every refusal
 * puts the tree back at the reviewed commit first, awaited rather than fired, and
 * names its outcome in the cause: "the tree is back where the gates read it" and
 * "the tree is still at the fixer's head" are different facts for an operator.
 */
export async function integrateFix(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  opts: {
    gateRead: string;
    fixHead: string;
    frozen: Record<string, string>;
    rows: DispatchUsageRow[];
    /** Filled with what the fix fold reverted, for the step's reason line. */
    disclosure: { reverted: string[] };
  },
): Promise<FixRoundOutcome> {
  const { repoRoot, issue } = ctx;
  const branch = specifyBranch(ctx.run.branch, issue);
  // The run's OWN worktree — never the fixer's, which no longer exists here.
  const wt = specifyWorktreePath(repoRoot, issue);
  // Awaited BEFORE the throw, and its outcome folded into the cause. A fire-and-forget
  // restore would race the throw on the next line, so the handback would be emitted while
  // the tree was mid-move and a failed restore would print only to a trace no operator
  // reads — leaving a branch checked out at the fixer's head with nothing in the cause
  // saying so.
  const fail = async (why: string): Promise<never> => {
    const undone = await restore(deps, wt, branch, opts.gateRead);
    throw new ReviewInfraError(`${why}${restoredSentence(undone, wt, opts.gateRead)}`, opts.rows);
  };
  // `publish`'s `assertPublishableBranch` was asked at the STEP ENTRY POINT and is
  // deliberately NOT re-asked here: on an unresolvable local mainline it probes
  // origin, so re-asking it once per fix round buys a network call for an answer
  // that cannot change while a step runs. The cheap charset check beside the argv
  // stays, below.
  if (!isFullCommitSha(opts.fixHead))
    throw new ReviewInfraError(
      `the fix round reported no commit to integrate (${JSON.stringify(opts.fixHead.slice(0, 40))})`,
      opts.rows,
    );
  // Bring the run's own branch to the fixer's head — NOT through
  // `ensureSpecifyWorktreeWithProvision`, whose `-B` would point the branch back at the base it was
  // given and throw the fix away before the push saw it. The tree is only the vehicle for a ref
  // update, so the ownership claim runs first and the move happens by reset, which also drops any
  // uncommitted sloppiness the child left behind.
  let notes: readonly SubmoduleNote[] = [];
  try {
    await assertSafeRef(branch);
    await assertSpecifyWorktreeOwned(deps.exec, {
      repoRoot,
      wt,
      baseSha: opts.gateRead,
      branch,
    });
    // The one primitive `specify` and `build` use for this, called directly.
    // `resetWorktreeToBase` does the `-B`, the `--hard`, the `clean` and the proof the
    // tree really got there, pointed at the fixer's head.
    notes = await resetWorktreeToBase(deps.exec, wt, opts.fixHead, branch);
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
  // The provisioning note stays trace-only; the submodule clause goes BOTH places — a trace line for
  // whoever opens the log, and the reason the caller composes for the run record, the PR and the
  // handoff, which are the only surfaces an operator who does not sees. A fix integrated from a tree
  // whose submodule was never populated is a fix nobody can re-run.
  const submodules = submoduleNoteClause(notes);
  if (submodules !== undefined)
    traceWarn(`lean review #${String(issue)}: run worktree after the fix reset — ${submodules}`);
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
  // fixer ran is refused by git itself rather than rewritten here. Reading origin
  // first would buy nothing — that read is stale the moment it returns.
  //
  // It is also the only git call in this step that leaves the clone, so it is the
  // one the seam gives the driver's non-interactive env to — the same `netGitEnv`
  // `publish`'s executor applies (`GIT_TERMINAL_PROMPT=0` plus
  // `-o BatchMode=yes`, so ssh fails instead of reading a passphrase from
  // /dev/tty and hanging the step). Every other call here is local.
  //
  // The name is checked with the driver's own `netRefProblem` immediately before
  // the argv is built, beside the command line it protects: an edit that MOVES or
  // drops the entry-point `assertPublishableBranch` cannot then silently put a
  // refspec (`a:b`), a force (`+x`) or an option (`-f`) — all of which
  // `assertSafeRef` calls legal — in front of a network git call. It reads the same
  // charset that entry point applied before this step paid for anything, so deleting
  // this line alone keeps `test-lean-review-push-guards.ts` green; what proves the
  // layering is that suite's "refused before anything mutated" assertion.
  const unsafe = netRefProblem(`refs/heads/${branch}`);
  if (unsafe !== undefined) return await fail(`refusing to push ${branch}: ${unsafe}`);
  const pushed = await gitQuiet(deps.exec, wt, [
    "push",
    "origin",
    `refs/heads/${branch}:refs/heads/${branch}`,
  ]);
  if (pushed === undefined)
    return await fail(`could not push the fix to origin/${branch}; the PR does not contain it`);
  // The disclosure travels with the head; only this place knows the tree was incomplete.
  return {
    head: opts.fixHead,
    ...(submodules === undefined ? {} : { submodules }),
    ...(opts.disclosure.reverted.length === 0 ? {} : { reverted: opts.disclosure.reverted }),
  };
}

/**
 * One fix wave: the child in its disposable tree, then its commits moved onto the branch.
 *
 * `wave` and `arm` are constants, not loop counters — the step dispatches one fixer — kept because
 * the tree's NAME must be reproducible from the durable run (see `fixTreeName`), which is what a
 * resumed attempt re-enters. The head returned is what origin now holds, read back from git.
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
    /** See `AdversarialArgs.derivedSpec`. */
    derivedSpec?: DerivedSpec;
    /** The project's configured protected globs, from the step's base-commit config, so the
     *  fixer's tree is judged by the SAME predicate as the builder's. */
    protected?: readonly string[];
    gate: string;
    wave: ReviewWave;
    arm: FixArm;
    attempt: number;
    runId: FixRunId;
    rows: DispatchUsageRow[];
    budget: BudgetArms;
  },
): Promise<FixRoundOutcome> {
  // The tree's name comes from the durable run alone, so a resume recomputes the
  // same path (see `fixTreeName`); a counter would restart at zero there.
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
    const fixer = await runFixer(deps, {
      issue: ctx.issue,
      wave: opts.wave,
      gate: opts.gate,
      findings: opts.findings,
      issueBody: opts.issueBody,
      ...(opts.derivedSpec === undefined ? {} : { derivedSpec: opts.derivedSpec }),
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
    // The ceiling's verdict first, so the fold below cannot capture a partial child.
    if (stop.fired !== undefined) return { stop: stop.fired };
    // A cut-off fixer gets ONE more turn in its own session before this wave is judged (see
    // `askTruncatedFixer`, which also runs it BEFORE the fold destroys the tree).
    const ran = await askTruncatedFixer(deps, {
      fixer,
      budget: opts.budget,
      fired: stop.fired,
      issue: ctx.issue,
      findings: opts.findings,
      worktree: wt,
      repoRoot: ctx.repoRoot,
      rows: opts.rows,
      worktreeRunId: `${String(opts.runId)}-${treeSuffix}` as FixRunId,
      // The same stamp the run's other children carry, from the function that decides it — not
      // re-derived here. Spread AFTER the caller's options so nothing above can opt it out.
      ...cycleChildOpts(deps),
    });
    // The fold's reverts reach the caller's reason line through this box: `foldFix`'
    // signature stays the head it advanced to.
    const disclosure: { reverted: string[] } = { reverted: [] };
    const integrated = await integrateFix(deps, ctx, {
      gateRead: opts.head,
      fixHead: await foldFix(deps, ctx, wt, { ...opts, disclosure }),
      frozen: opts.frozen,
      rows: opts.rows,
      disclosure,
    });
    return ran ? { ...integrated, truncated: true } : integrated;
  } finally {
    await removeWorktree(deps, ctx.repoRoot, wt);
  }
}
