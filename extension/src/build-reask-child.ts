/**
 * build-reask-child — the ask a wasted build turn makes.
 *
 * Split from `build-reask.ts` along the same seam as `lean/review-fix-child.ts`: the judgement,
 * prompt and clause stay with the detector, and this is the call. Through the fixer's own seam
 * (`deps.continueSession`, production `spawnDeveloperContinuationChild`), so the resumed child keeps
 * its roster, its tree and its fence — a follow-up, not a second opinion. No `report_blocked`
 * extension rides it (the dispatch adds that via `extraArgs`), so the first turn's report stands; the
 * step hands in `boundMs`, already clamped to what the step's deadline left. The row is billed BEFORE
 * the outcome is read, as `runFixer` bills its first child: a FAILED continuation was still one that
 * was tried.
 *
 * Lives outside `src/lean/` with the detector for the same reason: the bound clamp and the cost-row
 * builder are handed to it as parameters (`clampBoundMs`, `rowFor`), so all it takes from the lean
 * tree are type-only imports and no lean line is spent on the ask.
 */
import type {
  ContinuationOutcome,
  DeveloperContinuationFn,
} from "./developer-session-continuation.ts";
import type { DispatchUsageRow } from "./lean/step-budget.ts";
import { traceWarn } from "./trace.ts";
import type { WriteFence } from "./write-fence-contract.ts";
import type { BuildReaskTrigger } from "./build-reask.ts";

/** The ask's result: the row it cost (billed whatever it answered) and the resumed child's reply. */
export type BuildReaskOutcome = {
  row: DispatchUsageRow;
  outcome: ContinuationOutcome;
};

/** What the step hands the ask besides the child: the bound the seat's armed budget already clamped,
 *  and the row builder, which lives with the fixer's own cost rows. */
export type BuildReaskAsk = {
  /** The first child's own result — its recorded session, role and cost. */
  child: { role: string; transcriptPath?: string };
  trigger: BuildReaskTrigger;
  issue: number;
  /** The tree the first child worked in — the resumed child starts HERE, never here-here. */
  worktree: string;
  /** The first child's own fence, passed through: a continuation cannot be handed a wider one
   *  than the dispatch it resumes. */
  writeFence: WriteFence;
  /** The bound the caller clamped against `BUILD_REASK_BOUND_MS` and the armed minutes. */
  boundMs: number;
  /** The continuation's prompt, built by the caller from the trigger. */
  prompt: string;
  /** Bills the ask as a cost row, whatever the child answered. */
  rowFor: (outcome: ContinuationOutcome, role: string) => DispatchUsageRow;
  /** The run's permission stamp, threaded from the step (see `leanChildOpts`). */
  workCycleTrust?: boolean;
};

/** Ask the cut builder for one more turn in its own session, or `undefined` when the ask was REFUSED
 *  before a child was paid for (no seam, or no session path — the date-rollover guard: a path that no
 *  longer matches has nothing to continue, and a fresh child that never read the first turn is worse
 *  than today's exhaustion). Both refusals are traced. */
export async function askBuildReask(
  continueSession: DeveloperContinuationFn | undefined,
  opts: BuildReaskAsk,
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
    boundMs: opts.boundMs,
    prompt: opts.prompt,
    ...(opts.workCycleTrust === undefined ? {} : { workCycleTrust: opts.workCycleTrust }),
  });
  return { outcome, row: opts.rowFor(outcome, opts.child.role) };
}

/** The two refusals, each named on the trace so an exhausted step is never silent about the ask it
 *  did not make ("seam" | "path"). */
function traceRefused(child: { role: string }, which: "seam" | "path"): void {
  const why = which === "seam" ? "the step has no session seam" : "the child's session path is absent";
  traceWarn(`lean build #${String(child.role)}: no continuation — ${why}`);
}

