/**
 * lean/review-fix-child — the fixer's one dispatch, and the fold of what it left:
 * what happens to the disposable tree while it exists, the other half of the
 * lifetime seam that put its creation and destruction in `review-tree.ts`.
 */

import type { ContinuationOutcome } from "../developer-session-continuation.ts";
import type { DispatchResult } from "../types.ts";
import { normaliseBuild } from "./build-normalise.ts";
import { throwIfDispatchFailed } from "./dispatch-verdict.ts";
import type { HandlerCtx } from "./engine.ts";
import { type ReviewFixArgs, fixPrompt, fixWriteFence } from "./review-deps.ts";
import { continuationBoundMs, continuationPrompt, continuationRow } from "./review-fix-reask.ts";
import { FIX_BOUND_MS, type FixRunId, ReviewInfraError } from "./review.ts";
import type { ReviewDeps } from "./review.ts";
import { gitQuiet } from "./specify-reset.ts";
import type { BudgetArms, BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import { FIXER_ROLE, dispatchUsageRow } from "./step-budget.ts";

/** One fixer, and the row it cost. The result comes back for the one reader that can still use it —
 *  `review-fix-reask.ts`, which asks whether this child was cut off before it wrote anything. */
export async function runFixer(
  deps: ReviewDeps,
  opts: ReviewFixArgs & { rows: DispatchUsageRow[]; worktreeRunId: FixRunId },
): Promise<DispatchResult> {
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
        // anywhere the process can. Same scratch shape as `BuildDispatch`, and the
        // SAME expression the truncated continuation is fenced by (`fixWriteFence`).
        writeFence: fixWriteFence(opts.worktree, opts.repoRoot, opts.issue),
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
    return result;
  }
  throwIfDispatchFailed(result, ReviewInfraError, "the fix child failed: ", opts.rows);
  return result;
}

/**
 * The truncated fixer's continuation, and the row it cost.
 *
 * Lives beside `runFixer` because the row is the same shape built the same way: the fixer's role, the
 * fix tree's identity, and whatever the child reported. Keeping the two billing sites together is
 * what stops one of them from drifting — the wave that billed its first child and silently un-billed
 * its second would report a truncated fix as a one-child one, which is the under-billing #1930 shipped
 * with. Returns whether the continuation ran, so `fixRound` folds either way.
 */
export async function runFixerContinuation(
  deps: ReviewDeps,
  opts: {
    result: DispatchResult;
    budget: BudgetArms;
    fixerBoundMs: number;
    issue: number;
    findings: string;
    worktree: string;
    writeFence: { root: string; repo: string; scratch: string };
    rows: DispatchUsageRow[];
    worktreeRunId: FixRunId;
  },
): Promise<{ ran: true; outcome?: ContinuationOutcome } | { ran: false }> {
  const seam = deps.continueSession;
  // The outcome comes back on EVERY arm, and the one-shot guarantee lives in the CALLER (a
  // `truncated` flag in `fixRound`), not here: a continuation that failed is still a continuation
  // that was tried, and `fixRound` must not ask twice, so swallowing the failure into `ran: false`
  // would cost the wave's reason line the clause that says a second child was ever paid for — and
  // the wave would read, to an operator, exactly like a fixer nobody re-asked.
  const asked = (
    outcome: ContinuationOutcome | undefined,
  ): { ran: true; outcome?: ContinuationOutcome } => ({
    ran: true,
    ...(outcome === undefined ? {} : { outcome }),
  });
  if (seam === undefined) return { ran: false };
  const transcript = opts.result.transcriptPath;
  if (typeof transcript !== "string" || transcript === "") return { ran: false };
  const outcome = await seam({
    transcriptPath: transcript,
    role: opts.result.role,
    cwd: opts.worktree,
    writeFence: opts.writeFence,
    boundMs: continuationBoundMs(opts.budget, opts.fixerBoundMs),
    prompt: continuationPrompt(opts.issue, opts.findings),
  });
  // Billed on BOTH arms and BEFORE the outcome is read: a continuation that died or was bound still
  // spent tokens, and a row that went missing with the failure is how a wave loses its second child.
  opts.rows.push(continuationRow(outcome, opts.result.role, opts.worktreeRunId));
  return asked(outcome);
}

/**
 * Fold the fixer's UNCOMMITTED bytes into one commit before `removeWorktree`
 * destroys the tree with them — `build`'s `normaliseBuild`, so a fixer that edited
 * and never commits is captured rather than discarded. The gate is HEAD read from
 * git rather than believed: folding a round whose fixer committed would reset its
 * commits away. `branch: ""` resets DETACHED (this tree owns none); the frozen
 * refusal is `build`'s one spare — its reset restores an EDITED frozen path either
 * way, so the throw guards a wave that never answered its findings.
 *
 * The configured protected globs ride in on `opts` rather than being read here: the step has
 * already paid for that read, through the seam a test (and a resume) controls.
 */
export async function foldFix(
  deps: ReviewDeps,
  ctx: HandlerCtx,
  wt: string,
  opts: {
    head: string;
    frozen: Record<string, string>;
    attempt: number;
    rows: DispatchUsageRow[];
    /** The project's configured protected globs, from the step's base-commit config. */
    protected?: readonly string[];
    /** Filled with what the fold reverted, for the step's reason line. */
    disclosure: { reverted: string[] };
  },
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
    protected: opts.protected,
  });
  opts.disclosure.reverted = [...report.reverted];
  if (report.restored.length > 0)
    throw new ReviewInfraError(
      `the fix round changed the frozen acceptance contract: ${report.restored.join(", ")}`,
      opts.rows,
    );
  const after = await gitQuiet(deps.exec, wt, ["rev-parse", "HEAD"]);
  return after?.stdout?.trim() ?? "";
}
