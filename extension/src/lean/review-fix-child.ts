/**
 * lean/review-fix-child — the fixer's one dispatch, and the fold of what it left:
 * what happens to the disposable tree while it exists, the other half of the
 * lifetime seam that put its creation and destruction in `review-tree.ts`.
 */

import path from "node:path";
import type { DispatchResult } from "../types.ts";
import { normaliseBuild } from "./build-normalise.ts";
import { throwIfDispatchFailed } from "./dispatch-verdict.ts";
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
  // so no spread re-supplies it and wins over `FIX_BOUND_MS` (as in `review-deps.ts`).
  const { childBoundMs: budgetBoundMs, ...arms } = opts.budget.opts;
  try {
    result = await deps.dispatch(
      { role: FIXER_ROLE, prompt: fixPrompt(opts), cwd: opts.worktree },
      {
        // The smaller of the step's ceiling and the armed budget's: a budget may
        // only ever TIGHTEN the bound of the step's most expensive child.
        childBoundMs: Math.min(FIX_BOUND_MS, budgetBoundMs ?? Number.POSITIVE_INFINITY),
        // The fixer is a developer with a worktree and a contract, so it gets the
        // same fence `build`'s builder gets: without one a fixer could write
        // anywhere the process can. Same scratch shape as `BuildDispatch`.
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
        // The budget's other arms — the abort the turns/tokens levers fire, the hook
        // that fires it, and `budgetTurns` for the progress steer. Only
        // `childBoundMs` was taken out, so the spread cannot re-supply it.
        ...arms,
      },
    );
  } catch (err) {
    throw new ReviewInfraError(
      `the fix child could not be started: ${(err as Error)?.message ?? String(err)}`,
      opts.rows,
    );
  }
  // Billed before the verdict and billed once: a child that died still spent its
  // tokens, and a per-round total is how one fixer gets billed on both arms.
  const row = dispatchUsageRow(result);
  // The tree's identity rides in its own field (`runId`), validated with the row by
  // the loader, which keeps `ms` the child's real duration.
  row.runId = opts.worktreeRunId;
  opts.rows.push(row);
  const fired = opts.budget.fired(result);
  if (fired !== undefined) {
    opts.stop.fired = fired;
    return;
  }
  throwIfDispatchFailed(result, ReviewInfraError, "the fix child failed: ", opts.rows);
}

/**
 * Fold the fixer's UNCOMMITTED bytes into one commit before `removeWorktree`
 * destroys the tree with them — `build`'s `normaliseBuild`, so a fixer that edited
 * and never commits is captured rather than discarded. The gate is HEAD read from
 * git rather than believed: folding a round whose fixer committed would reset its
 * commits away. `branch: ""` resets DETACHED (this tree owns none); the frozen
 * refusal is `build`'s one spare — its reset restores an EDITED frozen path either
 * way, so the throw guards a wave that never answered its findings.
 */
export async function foldFix(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  wt: string,
  opts: { head: string; frozen: Record<string, string>; attempt: number; rows: DispatchUsageRow[] },
): Promise<string> {
  const at = (await gitQuiet(deps.exec, wt, ["rev-parse", "HEAD"]))?.stdout ?? "";
  const head = at.trim();
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
