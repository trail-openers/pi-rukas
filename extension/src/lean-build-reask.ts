/**
 * lean-build-reask — the whole pure decision about a BUILD turn that bought nothing, and the ONE
 * seam the build step spends its re-ask through.
 *
 * The defect this closes (field evidence, lean v0.14.x): a `developer` build child spent its whole
 * completion budget on reasoning — `stopReason: "length"` at the provider's output cap, 16,384
 * output tokens, and NO tool call. Pi exits 0, `ok` stays true, no kill cause is stamped, so
 * `dispatchBuilder` read it as a finished child, the fold found no change, and the step ended
 * `exhausted: the developer produced no change`. The existing no-work re-dispatch
 * (`lean/build-dispatch.ts`) cannot reach that shape: it needs a DEAD child
 * (`!ok || killCause || errorStop`). The sibling shape — one turn, `stopReason: "stop"`, no tool
 * call, no change — is judged the same way and gets the same one ask.
 *
 * Three rules, all of them the repo's, stated because this module is where they meet:
 *
 * 1. **Executed evidence, never prose.** A turn is judged by its OWN recorded `stopReason` and its
 *    OWN recorded tool-call fields. An absent stop reason, an absent tool-call record, or a result
 *    that cannot say either way is NOT a wasted turn: the absence must stay distinguishable from
 *    every parsed value, so an un-vouchable child takes today's exhaustion rather than buying a turn.
 * 2. **A kill, a provider fault or a ceiling is not a wasted turn, and the order is not cosmetic.**
 *    `killCause` and `errorStop` are branched FIRST — a child pi-rukas ended or the provider faulted
 *    is already routed by `dispatchBuilder` (`budget.fired()` → a `budget` stop, the dead-child
 *    branch → the no-work re-dispatch or a throw). Only then the budget, then the stop reason, then
 *    the tool calls. And the budget is read BEFORE the step spends anything: the turns/tokens levers
 *    share one `AbortController`, so a continuation dispatched after a breach is born aborted and
 *    answers nothing.
 * 3. **One shot, decided locally.** A resumed session REPLAYS the earlier turns, so a detector that
 *    saw the continuation's own result would keep asking. The one-shot is the caller's flag; the
 *    continuation's result is never handed back to the detector, and this module returns rather than
 *    recursing. A test counts dispatches, not the eventual head.
 *
 * What is NOT here: the fold (`normaliseBuild`, which owns what "no change" means) and the child
 * itself (`lean/build-reask-child.ts`, which wraps the same continuation seam the review fixer's
 * wave uses — `developer-session-continuation.ts`). This file decides whether to ask and what to
 * say; `lean/build.ts` owns the flag and the tree the answer lands in.
 *
 * It lives OUTSIDE `src/lean/` for its place in the graph: like `fixer-truncation.ts` it imports only
 * pure leaves out of `src/lean/` and is imported by one file inside it, so the pure suite drives the
 * whole decision with no step import and no git in sight, and the lean line total does not grow with
 * the build seat's provider policy.
 */

import { leanBuildReaskEnabled } from "./lean/build-reask-switch.ts";
import { TRUNCATED_STOP_REASON } from "./fixer-truncation.ts";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

/** A clean stop. Pi stamps it verbatim; a build turn that ended on it WITHOUT acting is the step's
 *  second wasted shape, and only that shape — a turn that made a tool call was working. */
export const CLEAN_STOP_REASON = "stop";

/** The build seat's own per-child bound for the continuation, ms. Not a knob: it is the shape of the
 *  child, which has its whole conversation already and owes one edit. The step clamps it to its
 *  armed budget (`continuationBoundMs`) and to the cycle deadline, so it never outlives either. */
export const BUILD_REASK_BOUND_MS = 15 * 60_000;

/** Why a build turn is NOT a wasted one — the arm the caller reads as "today's behaviour, unchanged".
 *  Kept as a name rather than a bare false so the trace can say which refusal fired. */
export type BuildNotReasked =
  /** The switch is at the literal `"0"`. */
  | "switch-off"
  /** pi-rukas ended the child: a budget or infrastructure stop that `dispatchBuilder` already routed. */
  | "killed"
  /** The provider faulted the child — routed by `dispatchBuilder`, never re-asked here. */
  | "provider-fault"
  /** The step's own ceiling had already fired — the continuation would be born aborted. */
  | "budget-fired"
  /** No assistant turn to read a stop reason off (a result rebuilt from disk). */
  | "no-final-turn"
  /** The child made a tool call, so work exists or the tool owns what happened next. */
  | "made-tool-call"
  /** A stop reason that is neither the output cap nor a clean stop. */
  | "other-stop";

/** What the step wants to know about one build turn. */
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

/** Did this build turn buy nothing?
 *
 * Every field is read from what the CHILD recorded. The order is the contract: kill cause and error
 * stop first, then the budget, then the stop reason, then the tool calls. Silence is never a pass in
 * either direction: `toolUses` is empty for a child killed mid-flight and `observedToolCalls` is the
 * live count that covers it, so a record its own counter contradicts is not vouchable as
 * call-free.
 */
export function buildTurnWasWasted(
  result: DispatchResult,
  deps: { budgetFired: boolean; /** The fold's answer: `report.files.length === 0`, judged by the caller. */ noChange: boolean },
): BuildWasted {
  if (!leanBuildReaskEnabled()) return notWasted("switch-off");
  // R2 — a self-kill is never a provider cap and never a wasted turn. `dispatchBuilder` already
  // routed it (`budget.fired()` → a stop; the dead-child branch → a re-dispatch or a throw), so
  // reaching here with a kill cause is a path that has not been routed; the safe reading is
  // today's, with no child spent.
  if (result.killCause !== undefined) return notWasted("killed");
  if (result.errorStop !== undefined) return notWasted("provider-fault");
  // The clock BEFORE the money: an aborted continuation answers nothing, and today's exhaustion is
  // what the step would have said anyway — with the continuation's tokens spent for nothing.
  if (deps.budgetFired) {
    // Named so an operator reading a step trace can tell "the step's ceiling had already fired"
    // from "nobody looked": that one is a budget question, the rest are provider questions.
    traceWarn(`lean build reask: no continuation — the step's budget had already fired`);
    return notWasted("budget-fired");
  }
  const stop = result.stopReason;
  // Absent is not "stop": a result with no recorded stop reason is one nobody watched finish, and
  // guessing a wasted turn from silence is how a gate starts reporting a confident wrong answer.
  if (typeof stop !== "string") return notWasted("no-final-turn");
  // Any tool call at all means the child acted: `readDispatched` already broke the dispatch loop on
  // this result, and a builder whose first turn wrote bytes then hit the cap has work the fold owns.
  if ((result.toolUses?.length ?? 0) > 0 || (result.observedToolCalls ?? 0) > 0) {
    return notWasted("made-tool-call");
  }
  if (stop === TRUNCATED_STOP_REASON) {
    return { wasted: true, trigger: "length", outputTokens: result.usage?.output ?? 0 };
  }
  // The second shape is only a wasted turn once the fold has said the tree holds no change: without
  // that it is a builder that read everything and declined to edit, which is a verdict, not a cut.
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

/**
 * The prompt the build continuation gets — one of two, chosen by the trigger that asked.
 *
 * Short on purpose: the resumed child has its whole conversation already, the brief it was handed
 * and the tree it was named in. A long second prompt re-briefs a child that is not missing the
 * brief, it is missing the tokens.
 */
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

/**
 * The clause naming a build turn that bought nothing, appended LAST to the exhausted reason when the
 * visit spent its ONE continuation and the tree still holds no change.
 *
 * A SUFFIX, never a replacement: `the developer produced no change` is matched verbatim on the step
 * record, the handback's cause line and the headless `failure.message`, so a reader keyed on that
 * phrase must keep finding it at the head. The token count is the fact that tells an operator a
 * provider cap from a builder that chose to do nothing. The clause sits at the END of a reason the
 * consumer clips, so it is short by construction.
 */
export function buildReaskClause(trigger: "length" | "no-change", outputTokens: number): string {
  const shape =
    trigger === "length"
      ? `the developer's last turn was cut off at the output-token limit (${String(
          outputTokens,
        )} tokens) before any tool call`
      : `the developer's last turn ended without a single tool call`;
  return `${shape}, and one continuation changed nothing`;
}
