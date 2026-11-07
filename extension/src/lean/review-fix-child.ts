/**
 * lean/review-fix-child — the fixer's one dispatch, and the fold of what it left.
 *
 * `review-git.ts` owns the ref. These are the two things that happen to the
 * disposable tree while it still exists — pay one developer, then make one commit
 * out of whatever it left — which is the same lifetime seam that put the tree's
 * creation and destruction in `review-tree.ts`, and neither can be judged from
 * the ref side, where the tree is already gone.
 *
 * Two rules the caller cannot re-check: the row is billed on every arm, before
 * any verdict or throw (`runFixer`); and the fold commits only what the child did
 * not commit for itself, gated on a HEAD read from git rather than believed.
 */

import path from "node:path";
import { traceWarn } from "../trace.ts";
import type { DispatchResult } from "../types.ts";
import { normaliseBuild } from "./build-normalise.ts";
import type { HandlerCtx } from "./engine.ts";
import { type ReviewFixArgs, fixPrompt } from "./review-deps.ts";
import { FIX_BOUND_MS, type FixRunId, ReviewInfraError } from "./review.ts";
import type { ReviewDeps } from "./review.ts";
import { gitQuiet } from "./specify-reset.ts";
import { specifyBranch } from "./specify-tree.ts";
import type { BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import { FIXER_ROLE, dispatchUsageRow } from "./step-budget.ts";

/**
 * One fixer, and the row it cost.
 *
 * The budget arms are DESTRUCTURED rather than spread, for the one reason
 * `review-deps.ts` gives for the lens leg: spreading `opts.budget.opts` after
 * `childBoundMs: FIX_BOUND_MS` re-supplied the key and the budget's value WON,
 * which made this constant decoration. `arms` is what the fixer may inherit
 * (the abort signal and the progress hook) with the one key it must not own
 * taken out of the object AND out of the type, so a future spread that could
 * carry a `childBoundMs` is a compile error rather than a bug waiting for
 * someone to reorder the lines. Same shape as `review-deps.ts`'s lens seam —
 * one shape for this rule in the module, not a helper.
 */
export async function runFixer(
  deps: ReviewDeps,
  opts: ReviewFixArgs & { rows: DispatchUsageRow[]; worktreeRunId: FixRunId },
): Promise<void> {
  let result: DispatchResult;
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
        // The step's budget's other arms: the abort the turns/tokens levers fire,
        // the progress hook that fires it, AND `budgetTurns` — the same turns
        // ceiling read as the denominator of the #1991 budget-progress steer, so
        // the fixer is told where it stands and commits before the abort lands.
        // `childBoundMs` is the one arm taken out above, so the spread cannot
        // re-supply it.
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
 * Fold the fixer's UNCOMMITTED bytes into one commit, the way `build` folds its
 * builder's, in the fix tree `wt` BEFORE that tree is destroyed: a fixer that
 * edited files and ended without committing leaves HEAD where this step put it,
 * and the caller's `removeWorktree` would destroy those bytes with the tree —
 * which is the field failure this fold exists to close.
 *
 * The gate is HEAD, read from git rather than trusted from the child: a fixer that
 * committed its own work has moved it, and the fold must not run on that round —
 * `normaliseBuild` resets to `headBefore` before it re-commits, so folding a
 * committed round would throw the child's commits away and re-make them as the
 * driver's. The child's own head is then what `integrate` moves, exactly as before
 * this fold existed.
 *
 * `normaliseBuild` owns the contract and the refusals: frozen and protected paths
 * are undone by its reset and named in its report. A frozen path the child merely
 * EDITED is what that reset restores, so the throw is not the branch's safety — it
 * is that a wave which edited the acceptance contract has not answered the findings
 * it was dispatched for, and walking on would verify a tree the fixer had already
 * tried to redefine.
 */
export async function foldFix(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  wt: string,
  opts: { head: string; frozen: Record<string, string>; attempt: number; rows: DispatchUsageRow[] },
): Promise<string> {
  const moved = await gitQuiet(deps.exec, wt, ["rev-parse", "HEAD"]);
  const head = (moved?.stdout ?? "").trim();
  // The gate, and the value the caller reads back as this round's head: a child
  // that committed its own work left a head the fold must not overwrite.
  if (head !== opts.head) return head;
  const report = await normaliseBuild({
    exec: deps.exec,
    wt,
    repoRoot: ctx.repoRoot,
    branch: specifyBranch(ctx.run.branch, ctx.issue),
    headBefore: opts.head,
    frozen: opts.frozen,
    attempt: opts.attempt,
    issue: ctx.issue,
    // The fixer's tree is DETACHED and the run's own tree holds the branch, so
    // the fold resets it detached: it needs the base's bytes, not a ref, and
    // `integrate` is the one place that moves the branch.
    detached: true,
  });
  const noted = [
    report.restored.length > 0 ? `restored: ${report.restored.join(", ")}` : "",
    report.reverted.length > 0 ? `reverted: ${report.reverted.join(", ")}` : "",
  ].filter((s) => s !== "");
  if (noted.length > 0) traceWarn(`lean review #${String(ctx.issue)}: ${noted.join("; ")}`);
  if (report.restored.length > 0)
    throw new ReviewInfraError(
      `the fix round changed the frozen acceptance contract: ${report.restored.join(", ")}`,
      opts.rows,
    );
  const after = await gitQuiet(deps.exec, wt, ["rev-parse", "HEAD"]);
  return after?.stdout?.trim() ?? "";
}
