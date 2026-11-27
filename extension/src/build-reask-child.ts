import type { BuildReaskTrigger } from "./build-reask.ts";
/**
 * build-reask-child — the ask a wasted build turn makes.
 *
 * Split from `build-reask.ts` along the same seam as `lean/review-fix-child.ts`: the judgement,
 * prompt and clause stay with the detector, and this is the call. Through the fixer's own seam
 * (`deps.continueSession`, production `spawnDeveloperContinuationChild`), so the resumed child keeps
 * its roster, its tree and its fence — a follow-up, not a second opinion. No `report_blocked`
 * extension rides it (the dispatch adds that via `extraArgs`), so the first turn's report stands; the
 * step hands in `boundMs`, already clamped to what the step's deadline left. The row is billed BEFORE
 * the outcome is read, as `runFixer` bills its first child: a continuation that RAN and answered
 * nothing was still one that spent tokens. A refusal that never spawned a child (`no-session`,
 * `unverified-role`, `spawn-failed`) is the other case and is returned as `undefined`, unbilled.
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

/** The ask's result: the one cost row the continuation that ran incurred. The reply itself is not
 *  carried out — the step's own fold reads the TREE the resumed child left, not what it said. */
export type BuildReaskOutcome = {
  row: DispatchUsageRow;
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
 *  before a child was paid for: no seam, no session path (the date-rollover guard — a path that no
 *  longer matches has nothing to continue, and a fresh child that never read the first turn is worse
 *  than today's exhaustion), or a seam that answered with a refusal and spawned nothing. Every such
 *  ask bills no row and spends nothing, so the step falls through to its ordinary exhausted verdict;
 *  each refusal is traced with the issue number. */
export async function askBuildReask(
  continueSession: DeveloperContinuationFn | undefined,
  opts: BuildReaskAsk,
): Promise<BuildReaskOutcome | undefined> {
  const transcript = opts.child.transcriptPath;
  if (continueSession === undefined || typeof transcript !== "string" || transcript === "") {
    traceRefused(opts.child, opts.issue, continueSession === undefined ? "seam" : "path");
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
  // A seam that refused without spawning — `no-session`, `unverified-role`, `spawn-failed` — bought no
  // child, so this is NOT an ask that was spent: no row, no clause, and the step gives today's verdict.
  // The trace names which refusal fired. A child that RAN and answered nothing is the other case: it
  // spent tokens, `runFixer` bills it, and the clause claims the ask was spent — so the row is owed
  // either way, and `rowFor` is called exactly once per ask.
  if (outcome.ok !== true) {
    traceWarn(`lean build #${String(opts.issue)}: no continuation — ${String(outcome.reason)}`);
    return undefined;
  }
  return { row: opts.rowFor(outcome, opts.child.role) };
}

/** The two refusals, each named on the trace so an exhausted step is never silent about the ask it
 *  did not make ("seam" | "path"). */
function traceRefused(child: { role: string }, issue: number, which: "seam" | "path"): void {
  const why =
    which === "seam" ? "the step has no session seam" : "the child's session path is absent";
  traceWarn(`lean build #${String(issue)}: no continuation — ${why}`);
}
