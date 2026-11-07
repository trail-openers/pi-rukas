/**
 * lean/review-fix-child — the fixer's one dispatch, and the fold of what it left.
 *
 * The lifetime seam that put the tree's creation and destruction in
 * `review-tree.ts`: these are what happen to the disposable tree while it exists.
 */

import path from "node:path";
import type { DispatchResult } from "../types.ts";
import { normaliseBuild } from "./build-normalise.ts";
import type { HandlerCtx } from "./engine.ts";
import { type ReviewFixArgs, fixPrompt } from "./review-deps.ts";
import { FIX_BOUND_MS, type FixRunId, ReviewInfraError } from "./review.ts";
import type { ReviewDeps } from "./review.ts";
import { gitQuiet } from "./specify-reset.ts";
import type { BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import { FIXER_ROLE, dispatchUsageRow } from "./step-budget.ts";

/** One fixer, and the row it cost. */
export async function runFixer(
  deps: ReviewDeps,
  opts: ReviewFixArgs & { rows: DispatchUsageRow[]; worktreeRunId: FixRunId },
): Promise<void> {
  let result: DispatchResult;
  // `arms` is `opts.budget.opts` with `childBoundMs` out of the object AND its type,
  // so no spread re-supplies it and wins over `FIX_BOUND_MS`. Same seam as the lens
  // leg in `review-deps.ts`.
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
 * Fold the fixer's UNCOMMITTED bytes into one commit before `removeWorktree`
 * destroys the tree with them — `build`'s `normaliseBuild`, so a fixer that edited
 * and never commits is captured rather than discarded. The gate is HEAD read from
 * git rather than believed: folding a round whose fixer committed would reset its
 * commits away. `branch: ""` resets DETACHED (this tree owns none), and the frozen
 * refusal is the one `build` has no use for: its reset restores an EDITED frozen
 * path either way, so the throw guards the wave, which has not answered its findings.
 */
export async function foldFix(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  wt: string,
  opts: { head: string; frozen: Record<string, string>; attempt: number; rows: DispatchUsageRow[] },
): Promise<string> {
  const at = (await gitQuiet(deps.exec, wt, ["rev-parse", "HEAD"]))?.stdout ?? "";
  const head = at.trim();
  // The gate, and the round's head when the fold must not run on it.
  if (head !== opts.head) return head;
  const report = await normaliseBuild({
    exec: deps.exec,
    wt,
    repoRoot: ctx.repoRoot,
    branch: "",
    headBefore: opts.head,
    frozen: opts.frozen,
    attempt: opts.attempt,
    issue: ctx.issue,
  });
  if (report.restored.length > 0)
    throw new ReviewInfraError(
      `the fix round changed the frozen acceptance contract: ${report.restored.join(", ")}`,
      opts.rows,
    );
  const after = await gitQuiet(deps.exec, wt, ["rev-parse", "HEAD"]);
  return after?.stdout?.trim() ?? "";
}
