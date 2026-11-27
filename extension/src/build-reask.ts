/**
 * build-reask — the judgement that a BUILD turn bought nothing, plus its prompt, clause and
 * switch. The defect: a build child spent its whole completion budget reasoning
 * (`stopReason: "length"` at the provider's output cap, NO tool call), the fold found no change, and
 * the step ended `exhausted: the developer produced no change`. The no-work re-dispatch cannot reach
 * it (`lean/build-dispatch.ts` needs a DEAD child); the sibling — one clean turn, no tool call, no
 * change — gets the same one ask. Three rules meet here. **Evidence, never prose:** a turn is judged
 * by its OWN recorded `stopReason` and tool calls; an absent stop reason, an absent tool-call record,
 * or a record its own counter contradicts is NOT wasted, so an un-vouchable child takes today's
 * exhaustion. **The order is not cosmetic:** `killCause`/`errorStop` branch first (already routed by
 * `dispatchBuilder`), then the budget, the stop reason, the tool calls — the budget BEFORE anything is
 * spent, since an aborted continuation answers nothing. **One shot:** a resumed session replays the
 * cut turn, so the flag is the caller's and this module returns rather than recursing. The ask itself
 * is `build-reask-child.ts`.
 *
 * Lives outside `src/lean/` because it is a judgement over fields the caller already holds: it takes
 * the fold's answer, the tool-call counts and the usage as plain parameters and imports no runtime
 * code from the lean tree, so the lean line total does not grow with it.
 */

import { TRUNCATED_STOP_REASON } from "./fixer-truncation.ts";
import { traceWarn } from "./trace.ts";

/** The fields of one build dispatch this judgement reads, and no more. Structural, not
 *  `DispatchResult`: the module that makes the call lives in the lean tree, and this one takes what
 *  it needs as parameters instead of importing the lean engine's types. */
export type BuildChildRecord = {
  /** A self-kill or an abort the step already routed; any value is a refusal. */
  killCause?: unknown;
  /** A provider fault the step already routed; any value is a refusal. */
  errorStop?: unknown;
  /** What Pi stamped the child's last turn. Absent is not a value to guess from. */
  stopReason?: string;
  /** The child's own recorded tool calls; empty for a child killed mid-flight. */
  toolUses?: unknown[];
  /** The live counter that covers the record a killed child never wrote. */
  observedToolCalls?: number;
  /** The child's own token report; the clause quotes its output count. */
  usage?: { output?: number };
};

/** A clean stop, stamped verbatim by Pi: the second wasted shape, a turn that ended WITHOUT acting. */
export const CLEAN_STOP_REASON = "stop";
/** The continuation's own bound, ms — not a knob but the shape of the child, which has its whole
 *  conversation already and owes one edit. `continuationBoundMs` clamps it to the armed budget. */
export const BUILD_REASK_BOUND_MS = 15 * 60_000;

/** Why a build turn is NOT wasted — a name, not a bare false, so the trace says which refusal
 *  fired. The first four are already routed elsewhere (`dispatchBuilder`, or the switch). */
export type BuildNotReasked =
  | "switch-off"
  | "killed"
  | "provider-fault"
  | "budget-fired"
  | "no-final-turn"
  | "made-tool-call"
  | "other-stop";

/** Which wasted shape decided the ask — the same token picks the prompt and the clause. */
export type BuildReaskTrigger = "length" | "no-change";

/** What the step wants to know about one build turn: wasted, or why not. */
export type BuildWasted =
  | {
      wasted: true;
      /** The shape that decided it, which is also which prompt the continuation gets. */
      trigger: BuildReaskTrigger;
      /** The cut turn's output tokens — the exhausted reason quotes it, so an operator tells a
       *  model that hit its cap from one that stopped early. */
      outputTokens: number;
    }
  | { wasted: false; reason: BuildNotReasked };

/** Did this build turn buy nothing? Every field comes from what the CHILD recorded, in order: kill
 *  cause and error stop, the budget, the stop reason, the tool calls. `toolUses` is empty for a child
 *  killed mid-flight and `observedToolCalls` is the live count that covers it, so a record its own
 *  counter contradicts is not vouchable as call-free. */
export function buildTurnWasWasted(
  result: BuildChildRecord,
  deps: {
    /** The fold's answer: `report.files.length === 0`, judged by the caller. */
    budgetFired: boolean;
    noChange: boolean;
  },
): BuildWasted {
  if (!leanBuildReaskEnabled()) return notWasted("switch-off");
  // A self-kill is never a provider cap, and `dispatchBuilder` already routed it; the safe reading of
  // an unrouted one is today's, with no child spent.
  if (result.killCause !== undefined) return notWasted("killed");
  if (result.errorStop !== undefined) return notWasted("provider-fault");
  // The clock BEFORE the money: an aborted continuation answers nothing, so the step would have said
  // today's exhaustion anyway — with the continuation's tokens spent for nothing.
  if (deps.budgetFired) {
    traceWarn(`lean build reask: no continuation — the step's budget had already fired`);
    return notWasted("budget-fired");
  }
  const stop = result.stopReason;
  // Absent is not "stop": guessing a wasted turn from an unwatched finish is how a gate starts
  // reporting a confident wrong answer.
  if (typeof stop !== "string") return notWasted("no-final-turn");
  // Any tool call means the child acted; a builder that wrote bytes before the cap has work the fold
  // owns.
  if ((result.toolUses?.length ?? 0) > 0 || (result.observedToolCalls ?? 0) > 0) {
    return notWasted("made-tool-call");
  }
  if (stop === TRUNCATED_STOP_REASON) {
    return { wasted: true, trigger: "length", outputTokens: result.usage?.output ?? 0 };
  }
  // The second shape is wasted only once the fold says nothing changed; else it is a builder that read
  // everything and declined to edit — a verdict, not a cut.
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

/** The continuation's prompt, one of two by trigger. Short on purpose: the resumed child is missing
 *  tokens, not the brief. */
export function buildReaskPrompt(issue: number, trigger: BuildReaskTrigger): string {
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

/** The clause appended LAST to the exhausted reason when the visit spent its ONE continuation and the
 *  tree still holds no change. A SUFFIX, never a replacement: `the developer produced no change` is
 *  matched verbatim on the step record, the handback's cause line and the headless `failure.message`,
 *  and the consumer clips from the end — so this is short by build, and the token count inside it is
 *  what tells an operator a provider cap from a builder that chose to do nothing. */
export function buildReaskClause(trigger: BuildReaskTrigger, outputTokens: number): string {
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
