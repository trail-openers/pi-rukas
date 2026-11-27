/**
 * lean/build-reask — a BUILD turn that bought nothing: the judgement, the prompt, the clause, the
 * switch and the ask. The defect: a build child spent its whole completion budget reasoning
 * (`stopReason: "length"` at the provider's output cap, 16,384 tokens, NO tool call), so the fold
 * found no change and the step ended `exhausted: the developer produced no change`. The no-work
 * re-dispatch cannot reach it (`build-dispatch.ts` needs a DEAD child); the sibling — one clean turn,
 * no tool call, no change — gets the same one ask.
 *
 * Three rules, stated because this module is where they meet. **Evidence, never prose:** a turn is
 * judged by its OWN recorded `stopReason` and tool calls; an absent stop reason, an absent tool-call
 * record, or a record its own counter contradicts is NOT wasted — absence stays distinguishable from
 * every parsed value, so an un-vouchable child takes today's exhaustion. **The order is not
 * cosmetic:** `killCause`/`errorStop` branch first (both already routed by `dispatchBuilder`), then
 * the budget, the stop reason, the tool calls — and the budget is read BEFORE anything is spent, since
 * an aborted continuation answers nothing. **One shot, decided locally:** a resumed session replays the
 * earlier turns, so the one-shot is the caller's flag and this module returns rather than recursing.
 * The fold (`normaliseBuild`) owns "no change".
 */

import { TRUNCATED_STOP_REASON } from "../fixer-truncation.ts";
import { traceWarn } from "../trace.ts";
import type { DispatchResult } from "../types.ts";

/** A clean stop, stamped verbatim by Pi. A turn that ended on it WITHOUT acting is the step's second
 *  wasted shape — a turn that made a tool call was working. */
export const CLEAN_STOP_REASON = "stop";

/** The continuation's own per-child bound, ms. Not a knob: it is the shape of the child, which has
 *  its whole conversation already and owes one edit. `continuationBoundMs` clamps it to the step's
 *  armed budget and the cycle deadline, so it never outlives either. */
export const BUILD_REASK_BOUND_MS = 15 * 60_000;

/** Why a build turn is NOT a wasted one — the arm the caller reads as today's behaviour. A name, not
 *  a bare false, so the trace says which refusal fired. The first four are already routed elsewhere
 *  (`dispatchBuilder`, or the switch); the last three are this function's own refusals. */
export type BuildNotReasked =
  | "switch-off"
  | "killed"
  | "provider-fault"
  | "budget-fired"
  | "no-final-turn"
  | "made-tool-call"
  | "other-stop";

/** What the step wants to know about one build turn: wasted, or why not. */
export type BuildWasted =
  | {
      wasted: true;
      /** The shape that decided it, which is also which prompt the continuation gets. */
      trigger: "length" | "no-change";
      /** The output tokens the cut turn cost — the number the exhausted reason quotes, so an
       *  operator tells a model that hit its cap from one that stopped early. */
      outputTokens: number;
    }
  | { wasted: false; reason: BuildNotReasked };

/** Did this build turn buy nothing? Every field comes from what the CHILD recorded, in the order the
 *  contract states: kill cause and error stop, the budget, the stop reason, the tool calls. Silence is
 *  never a pass either way — `toolUses` is empty for a child killed mid-flight and `observedToolCalls`
 *  is the live count that covers it, so a record its own counter contradicts is not vouchable as
 *  call-free. */
export function buildTurnWasWasted(
  result: DispatchResult,
  deps: {
    budgetFired: boolean /** The fold's answer: `report.files.length === 0`, judged by the caller. */;
    noChange: boolean;
  },
): BuildWasted {
  if (!leanBuildReaskEnabled()) return notWasted("switch-off");
  // A self-kill is never a provider cap, and `dispatchBuilder` already routed it; the safe reading
  // of an unrouted one is today's, with no child spent.
  if (result.killCause !== undefined) return notWasted("killed");
  if (result.errorStop !== undefined) return notWasted("provider-fault");
  // The clock BEFORE the money: an aborted continuation answers nothing, and today's exhaustion is
  // what the step would have said anyway — with the continuation's tokens spent for nothing.
  if (deps.budgetFired) {
    traceWarn(`lean build reask: no continuation — the step's budget had already fired`);
    return notWasted("budget-fired");
  }
  const stop = result.stopReason;
  // Absent is not "stop": guessing a wasted turn from an unwatched finish is how a gate starts
  // reporting a confident wrong answer.
  if (typeof stop !== "string") return notWasted("no-final-turn");
  // Any tool call means the child acted, and a builder that wrote bytes before the cap has work the
  // fold owns.
  if ((result.toolUses?.length ?? 0) > 0 || (result.observedToolCalls ?? 0) > 0) {
    return notWasted("made-tool-call");
  }
  if (stop === TRUNCATED_STOP_REASON) {
    return { wasted: true, trigger: "length", outputTokens: result.usage?.output ?? 0 };
  }
  // The second shape is wasted only once the fold says nothing changed; else it is a builder that
  // read everything and declined to edit — a verdict, not a cut.
  if (stop === CLEAN_STOP_REASON) {
    return deps.noChange
      ? { wasted: true, trigger: "no-change", outputTokens: result.usage?.output ?? 0 }
      : notWasted("other-stop");
  }
  return notWasted("other-stop");
}

function notWasted(reason: BuildNotReasked): BuildWasted {
  return { wasted: false, reason };
}

/** The prompt the continuation gets, one of two by trigger. Short on purpose: the resumed child has
 *  its whole conversation already — it is missing tokens, not the brief. */
export function buildReaskPrompt(issue: number, trigger: "length" | "no-change"): string {
  const why =
    trigger === "length"
      ? `Your previous turn ran out of the model's output budget while you were still reasoning (issue #${String(
          issue,
        )}), so you never acted and nothing has changed — this is the same session and the work is not lost.`
      : `The tree is unchanged since your previous turn ended (issue #${String(
          issue,
        )}): you answered without making a single tool call, so nothing was implemented.`;
  return `${why}

Act now with tool calls: make the smallest edit the frozen acceptance tests require, then verify it. Do not restate the brief and keep the reasoning short — the last turn spent its whole output budget on reasoning and produced nothing.`;
}

/** The clause naming a build turn that bought nothing, appended LAST to the exhausted reason when the
 *  visit spent its ONE continuation and the tree still holds no change. A SUFFIX, never a replacement:
 *  `the developer produced no change` is matched verbatim on the step record, the handback's cause line
 *  and the headless `failure.message`. The token count is what tells an operator a provider cap from a
 *  builder that chose to do nothing, and the consumer clips from the end, so it is short by build. */
export function buildReaskClause(trigger: "length" | "no-change", outputTokens: number): string {
  const shape =
    trigger === "length"
      ? `the developer's last turn was cut off at the output-token limit (${String(
          outputTokens,
        )} tokens) before any tool call`
      : `the developer's last turn ended without a single tool call`;
  return `${shape}, and one continuation changed nothing`;
}

/** The switch's only reader. Default ON — only the literal `"0"` takes it out, read at CALL time (the
 *  `LEAN_FIXER_TRUNCATION_REASK` discipline: a switch a shell accident could flip is a lost cell). */
export const leanBuildReaskEnabled = (): boolean =>
  process.env.PI_ENSEMBLE_LEAN_BUILD_REASK !== "0";

/**
 * The ask, and the row it cost. Through the fixer's own seam (`deps.continueSession`, production
 * `spawnDeveloperContinuationChild`): `pi --mode rpc --session <the first child's transcript>` resumes
 * the child in its own conversation, with the developer's roster, its tree and the fence it was
 * already behind — which is what makes it a follow-up and not a second opinion. Two consequences the
 * issue accepted: no `report_blocked` extension rides the continuation (the dispatch adds it via
 * `extraArgs`, the seam loads none), so the first turn's report stands; and `continuationBoundMs`
 * takes the smaller of the seat's ceiling and what the deadline left, so a re-ask cannot outlive its
 * first child's deadline. The row is billed on BOTH arms and BEFORE the outcome is read, as `runFixer`
 * bills its first child: a FAILED continuation was still one that was tried, which is what makes the
 * exhausted clause honest.
 */

import type {
  ContinuationOutcome,
  DeveloperContinuationFn,
} from "../developer-session-continuation.ts";
import { continuationBoundMs, continuationRow } from "../fixer-truncation.ts";
import type { WriteFence } from "../write-fence-contract.ts";
import type { BudgetArms, DispatchUsageRow } from "./step-budget.ts";

/** The child the step asked for, and what it did with the ask: the row it cost (billed whatever it
 *  answered) and the resumed child's own reply, or why it did not. */
export type BuildReaskOutcome = {
  row: DispatchUsageRow;
  outcome: ContinuationOutcome;
};

/**
 * Ask the cut builder for one more turn in its own session, or return `undefined` when the ask was
 * REFUSED before a child was paid for (no seam, or no session path). The date-rollover guard lives
 * here: `transcriptPathFor` puts each day's runs in a dated directory, so a child whose path no
 * longer matches has nothing to continue — and a fresh child that never read the first turn is worse
 * than today's exhaustion. Both refusals are traced. */
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
    traceRefused(opts.child, seam === undefined ? "seam" : "path");
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

/** The two refusals, each named on the trace so an exhausted step is never silent about the ask it did
 *  not make: "seam" = no continuation seam, "path" = the child's session file is gone. */
function traceRefused(child: DispatchResult, which: "seam" | "path"): void {
  const why =
    which === "seam" ? "the step has no session seam" : "the child's session path is absent";
  traceWarn(`lean build #${String(child.role)}: no continuation — ${why}`);
}
