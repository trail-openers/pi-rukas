/**
 * lean/review-fix-child — the fixer's one dispatch, and the fold of what it left:
 * what happens to the disposable tree while it exists, the other half of the
 * lifetime seam that put its creation and destruction in `review-tree.ts`.
 */
import {
  continuationBoundMs,
  continuationPrompt,
  continuationRow,
  fixerWasTruncated,
} from "../fixer-truncation.ts";
import type { DispatchResult } from "../types.ts";
import { normaliseBuild } from "./build-normalise.ts";
import { throwIfDispatchFailed } from "./dispatch-verdict.ts";
import type { HandlerCtx } from "./engine.ts";
import { type ReviewFixArgs, fixPrompt, fixWriteFence } from "./review-deps.ts";
import { FIX_BOUND_MS, type FixRunId, type ReviewDeps, ReviewInfraError } from "./review.ts";
import { gitQuiet } from "./specify-reset.ts";
import type { BudgetArms, BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import { FIXER_ROLE, dispatchUsageRow } from "./step-budget.ts";

/** One fixer, and the row it cost. The result comes back for the one reader that can still use it —
 *  `fixer-truncation.ts`, which asks whether this child was cut off before it wrote anything. */
export async function runFixer(
  deps: ReviewDeps,
  opts: ReviewFixArgs & { rows: DispatchUsageRow[]; worktreeRunId: FixRunId },
): Promise<DispatchResult> {
  let result: DispatchResult;
  // `arms` is `opts.budget.opts` with `childBoundMs` out of the object AND its type, so no spread
  // re-supplies it and wins over `FIX_BOUND_MS` (as in `review-deps.ts`). The `stall` arm stays in.
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
 * The truncated fixer's SECOND child: the judgement, the ask, and the row it cost.
 *
 * The detector (`fixerWasTruncated`) is pure and the ask is not; only the detector's `true` answer
 * pays for a child. It runs BEFORE the fold, which commits the child's bytes and then destroys the
 * tree. The row is billed on BOTH arms and BEFORE the outcome is read — a continuation that died still
 * spent tokens — in the same shape `runFixer` bills its first child, so neither site un-bills its
 * child. The return is the wave's one-shot answer: a FAILED continuation was still one that was tried.
 */
export async function askTruncatedFixer(
  deps: ReviewDeps,
  opts: {
    fixer: DispatchResult;
    budget: BudgetArms;
    /** The ceiling's verdict, if the step's own budget had already stopped this wave. */
    fired: BudgetFired | undefined;
    issue: number;
    findings: string;
    worktree: string;
    repoRoot: string;
    rows: DispatchUsageRow[];
    worktreeRunId: FixRunId;
    /** The run's permission stamp, threaded from `ReviewDeps.headless` by the step (see
     *  `leanChildOpts` / `DeveloperContinuationFn.workCycleTrust`). A continuation that omitted it
     *  would be born permission-denied on exactly the arm where its parent fixer ran trusted. */
    workCycleTrust?: boolean;
  },
): Promise<boolean> {
  const truncated = (
    await fixerWasTruncated(opts.fixer, {
      seam: deps.continueSession !== undefined,
      budgetFired: opts.fired !== undefined,
    })
  ).truncated;
  const seam = deps.continueSession;
  if (truncated !== true || seam === undefined) return false;
  const transcript = opts.fixer.transcriptPath;
  if (typeof transcript !== "string" || transcript === "") return false;
  const outcome = await seam({
    transcriptPath: transcript,
    role: opts.fixer.role,
    cwd: opts.worktree,
    writeFence: fixWriteFence(opts.worktree, opts.repoRoot, opts.issue),
    boundMs: continuationBoundMs(opts.budget, FIX_BOUND_MS),
    prompt: continuationPrompt(opts.issue, opts.findings),
    ...(opts.workCycleTrust === undefined ? {} : { workCycleTrust: opts.workCycleTrust }),
  });
  opts.rows.push(continuationRow(outcome, opts.fixer.role, opts.worktreeRunId));
  return true;
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
