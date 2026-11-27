import type {
  ContinuationOutcome,
  DeveloperContinuationFn,
} from "../developer-session-continuation.ts";
import { continuationBoundMs, continuationRow } from "../fixer-truncation.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult } from "../types.ts";
import type { WriteFence } from "../write-fence-contract.ts";
/**
 * lean/build-reask-child — the ask itself, and the switch that lets a build step make it.
 *
 * Split from `build-reask.ts` for the cap on `src/lean/` (AGENTS.md §6): the judgement, the prompt
 * and the clause stay with the step's decision, and this is the seam call. It goes through the
 * fixer's own seam (`deps.continueSession`, production `spawnDeveloperContinuationChild`):
 * `pi --mode rpc --session <the first child's transcript>` resumes the child in its own conversation,
 * with its roster, its tree and the fence it was already behind — what makes it a follow-up and not a
 * second opinion. Accepted consequences: no `report_blocked` extension rides it (the dispatch adds
 * that via `extraArgs`), so the first turn's report stands; and `continuationBoundMs` takes the
 * smaller of the seat's ceiling and what the deadline left, so a re-ask cannot outlive its first
 * child's deadline. The row is billed on BOTH arms and BEFORE the outcome is read, as `runFixer` bills
 * its first child — a FAILED continuation was still one that was tried, which is what makes the
 * exhausted clause honest.
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
