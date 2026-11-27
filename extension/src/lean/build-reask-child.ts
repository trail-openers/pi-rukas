import type {
  ContinuationOutcome,
  DeveloperContinuationFn,
} from "../developer-session-continuation.ts";
import { continuationBoundMs, continuationRow } from "../fixer-truncation.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult } from "../types.ts";
import type { WriteFence } from "../write-fence-contract.ts";
/**
 * lean/build-reask-child — the ask a wasted build turn makes, and the switch that lets it make one.
 *
 * Split from `build-reask.ts` for the cap on `src/lean/` (AGENTS.md §6), along the same seam as
 * `review-fix-child.ts`: the judgement, prompt and clause stay with the step's decision, and this is
 * the call. Through the fixer's own seam (`deps.continueSession`, production
 * `spawnDeveloperContinuationChild`), so the resumed child keeps its roster, its tree and its fence —
 * a follow-up, not a second opinion. No `report_blocked` extension rides it (the dispatch adds that
 * via `extraArgs`), so the first turn's report stands; `continuationBoundMs` clamps the bound to what
 * the step's deadline left. The row is billed BEFORE the outcome is read, as `runFixer` bills its
 * first child: a FAILED continuation was still one that was tried.
 */
import {
  BUILD_REASK_BOUND_MS,
  type BuildReaskTrigger,
  buildReaskPrompt,
  leanBuildReaskEnabled,
} from "./build-reask.ts";
import type { BudgetArms, DispatchUsageRow } from "./step-budget.ts";

export { leanBuildReaskEnabled };

/** The ask's result: the row it cost (billed whatever it answered) and the resumed child's reply. */
export type BuildReaskOutcome = {
  row: DispatchUsageRow;
  outcome: ContinuationOutcome;
};

/** Ask the cut builder for one more turn in its own session, or `undefined` when the ask was REFUSED
 *  before a child was paid for (no seam, or no session path — the date-rollover guard: a path that no
 *  longer matches has nothing to continue, and a fresh child that never read the first turn is worse
 *  than today's exhaustion). Both refusals are traced. */
export async function askBuildReask(
  continueSession: DeveloperContinuationFn | undefined,
  opts: {
    /** The first child's own result — its recorded session, role and cost. */
    child: DispatchResult;
    /** The visit's armed budget: the bound comes from it, never from a fresh ceiling. */
    budget: BudgetArms;
    trigger: BuildReaskTrigger;
    issue: number;
    /** The tree the first child worked in — the resumed child starts HERE, never here-here. */
    worktree: string;
    /** The first child's own fence, passed through: a continuation cannot be handed a wider one
     *  than the dispatch it resumes. */
    writeFence: WriteFence;
    /** The run's permission stamp, threaded from the step (see `leanChildOpts`). */
    workCycleTrust?: boolean;
  },
): Promise<BuildReaskOutcome | undefined> {
  const transcript = opts.child.transcriptPath;
  if (continueSession === undefined || typeof transcript !== "string" || transcript === "") {
    traceRefused(opts.child, continueSession === undefined ? "seam" : "path");
    return undefined;
  }
  const outcome = await continueSession({
    // The first child's own session file — the thing that makes this a follow-up, and the only
    // observable that distinguishes it from a re-spawn.
    transcriptPath: transcript,
    role: opts.child.role,
    cwd: opts.worktree,
    writeFence: opts.writeFence,
    boundMs: continuationBoundMs(opts.budget, BUILD_REASK_BOUND_MS),
    prompt: buildReaskPrompt(opts.issue, opts.trigger),
    ...(opts.workCycleTrust === undefined ? {} : { workCycleTrust: opts.workCycleTrust }),
  });
  return { outcome, row: continuationRow(outcome, opts.child.role, undefined) };
}

/** The two refusals, each named on the trace so an exhausted step is never silent about the ask it
 *  did not make ("seam" | "path"). */
function traceRefused(child: DispatchResult, which: "seam" | "path"): void {
  const why =
    which === "seam" ? "the step has no session seam" : "the child's session path is absent";
  traceWarn(`lean build #${String(child.role)}: no continuation — ${why}`);
}
