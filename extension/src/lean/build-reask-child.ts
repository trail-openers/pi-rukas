/**
 * lean/build-reask-child — the build step's one continuation, and the row it cost.
 *
 * The judgement, the ask, and the billing for a build turn that bought nothing
 * (`lean-build-reask.ts` decides whether). It goes through the SAME continuation seam the review
 * fixer's wave uses — `deps.continueSession`, production `spawnDeveloperContinuationChild` — which
 * is what makes it a follow-up rather than a second opinion: `pi --mode rpc --session <the first
 * child's transcript>` resumes the child in its own conversation, with the developer's own tool
 * roster, the tree it was already working in, and the fence it was already behind.
 *
 * Two consequences of that choice, both accepted by the issue's decision rather than discovered
 * here:
 *
 * - **the continuation carries no `report_blocked` extension.** The build child's dispatch adds it
 *   through `extraArgs`; the continuation seam loads no forwarded extension. So a builder cannot
 *   file a blocked report on its continuation turn, and the report the FIRST turn filed is judged
 *   as today, exactly as if the ask had never happened.
 * - **the seam owns its own kill and its own bound** (`boundMs`, a bare timer with no grace phase),
 *   which is why the bound is derived from the step's ARMED budget rather than from the row's
 *   configured minutes: `continuationBoundMs` takes the smaller of the build seat's ceiling and what
 *   the deadline left, so a re-ask can never outlive the deadline the first child was bounded by.
 *
 * The row is billed on BOTH arms and BEFORE the outcome is read — a continuation that died still
 * spent tokens — in the same shape `runFixer` bills its first child, so neither site un-bills its
 * child. The return is the visit's one-shot answer: a FAILED continuation was still one that was
 * tried, which is what makes the exhausted clause honest.
 */
import { continuationBoundMs, continuationRow } from "../fixer-truncation.ts";
import { BUILD_REASK_BOUND_MS, buildReaskPrompt } from "../lean-build-reask.ts";
import { traceWarn } from "../trace.ts";
import type { ContinuationOutcome, DeveloperContinuationFn } from "../developer-session-continuation.ts";
import type { DispatchResult } from "../types.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import type { BudgetArms, DispatchUsageRow } from "./step-budget.ts";

/** The child the step asked for, and what it did with the ask. */
export type BuildReaskOutcome = {
  /** The row the continuation cost — billed whatever it answered. */
  row: DispatchUsageRow;
  /** The resumed child's own reply, or why it did not. */
  outcome: ContinuationOutcome;
};

/**
 * Ask the cut builder for one more turn in its own session.
 *
 * Returns `undefined` when the ask was REFUSED before a child was paid for — no seam, or no session
 * path to resume. The date-rollover guard lives here: `transcriptPathFor` puts each day's runs in
 * their own dated directory, so a first child whose path no longer matches what the seam needs has
 * nothing to continue, and starting a fresh child in ignorance of what the first one read is worse
 * than today's exhaustion. The refusal is traced, because an exhausted step that says nothing about
 * the ask it never made is indistinguishable from one that never considered it.
 */
export async function askBuildReask(
  continueSession: DeveloperContinuationFn | undefined,
  opts: {
    /** The first child's own result — its recorded session, role and cost. */
    child: DispatchResult;
    /** The visit's armed budget: the bound is taken from it, never from a fresh ceiling. */
    budget: BudgetArms;
    trigger: "length" | "no-change";
    issue: number;
    /** The tree the first child worked in — the resumed child starts HERE, never here-here. */
    worktree: string;
    /** The fence the first child ran behind, passed through rather than re-derived so a
     *  continuation cannot be handed a wider one than the dispatch it resumes. */
    writeFence: WriteFence;
    /** The run's permission stamp, threaded from the step (see `leanChildOpts`). */
    workCycleTrust?: boolean;
  },
): Promise<BuildReaskOutcome | undefined> {
  const seam = continueSession;
  const transcript = opts.child.transcriptPath;
  if (seam === undefined || typeof transcript !== "string" || transcript === "") {
    traceRefused(opts.child, transcript);
    return undefined;
  }
  const outcome = await seam({
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

/** The two refusures, told apart on the trace: a harness with no seam at all, and a child whose
 *  session file is gone (a date rollover, or a dispatch that never wrote one). */
function traceRefused(child: DispatchResult, transcript: string | undefined): void {
  traceWarn(
    `lean build #${String(child.role)}: no continuation — ${
      typeof transcript === "string" && transcript !== ""
        ? "the step has no session seam"
        : "the child's session path is absent; no re-ask"
    }`,
  );
}
