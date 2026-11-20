/**
 * lean/fixer-truncation — the whole pure decision about a fixer whose last turn was CUT OFF at the
 * output-token limit: the switch, the detector, the continuation's bound, its prompt and its cost row.
 *
 * The defect this closes (field evidence, lean v0.14.90 / pi 1.4.0): the run's verified head was
 * correct, the fixer did six read-only turns and then one thinking block that ended with
 * `stopReason: "length"` at exactly the model's output cap, with zero edit or write calls. Pi exits
 * 0, `ok` stays true, no kill cause is stamped — so the step read the wave as a child that was paid
 * for and changed nothing, and `assertFixAdvanced` handed the run back with `review fix produced no
 * change` while the branch it had already verified sat untouched.
 *
 * Three rules, all of them the repo's, stated because this module is where they meet:
 *
 * 1. **Executed evidence, never prose.** A child is judged truncated by its OWN recorded
 *    `stopReason` and its OWN recorded tool calls — the fields the replay wrote — not by what it
 *    said about itself. An absent stop reason, an absent tool-call record, or a result that cannot
 *    say either way is NOT truncation: the absence must stay distinguishable from every parsed
 *    value, so an un-vouchable child takes today's handback rather than buying a turn.
 * 2. **A kill is not a truncation, and the order is not cosmetic.** `killCause` is branched FIRST:
 *    a child the bound, the abort or the inactivity watch ended is a budget or infrastructure stop,
 *    already routed by `runFixer`, and no re-ask follows it. Only a child that ended on its own
 *    terms with `stopReason: "length"` is a candidate. And the budget is read BEFORE the step spends
 *    anything on the continuation — the turns/tokens levers share one AbortController, so a child
 *    dispatched after a breach is born already-aborted and would answer nothing.
 * 3. **One shot, decided locally.** A resumed session REPLAYS the truncated turn, so a second
 *    detection would see the same `"length"` and could keep asking. The one-shot guarantee is the
 *    caller's wave: the continuation's own result is never handed back to the detector, and this
 *    module returns rather than recursing. A test counts dispatches, not the eventual head.
 *
 * What is NOT here: the child's spawn (`developer-session-continuation.ts`, injected through
 * `ReviewDeps.continueSession`), the fold, or the integration. This file decides whether to ask and
 * what to say; `review-git.ts`'s `fixRound` owns the tree the answer lands in.
 *
 * It lives OUTSIDE `src/lean/` on purpose (AGENTS.md §6): every function here is pure — the switch,
 * the judgement, the bound, the prompt and the cost row — so the whole decision is one leaf module
 * that the step consults and the pure suite drives, with no step import to break. `src/lean/` is held
 * under a 26 000-line cap by an offline test, and this decision's evidence lives in its prose: prose
 * does not earn that cap, a module that can be a leaf does.
 */

import type { ContinuationOutcome } from "./developer-session-continuation.ts";
import { type BudgetArms, type DispatchUsageRow, FIXER_ROLE } from "./lean/step-budget.ts";
import { fenceText } from "./lean/text-fence.ts";
import { traceWarn } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import { madeWriteCall } from "./write-fence.ts";

/** The stop reason a model ends a turn with when the provider's output cap is reached. Pi passes it
 *  through verbatim; the harness never invents it. */
export const TRUNCATED_STOP_REASON = "length";

/** Whether a truncated review fixer is continued once before the wave is judged. Read at CALL time,
 *  not at module load: every lean smoke file runs in one bun process and pins off/on arms with a
 *  `withEnv` helper, so a load-time read would let one file's pin silently change the next file's
 *  arm. */
export function leanFixerTruncationReaskEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK !== "0";
}

/** What the wave wants to know about its fixer. */
export type FixerTruncation =
  | {
      truncated: true;
      /** The output tokens the truncated turn cost — the number the handback names, so an operator
       *  can tell a model that hit its cap from one that stopped early, and can see the cap is the
       *  provider's rather than a knob this harness sets. */
      outputTokens: number;
    }
  | { truncated: false; reason: FixerNotTruncated };

/** Why a fixer is NOT a truncated one — the arm the caller reads as "today's behaviour, unchanged".
 *  Kept as a name rather than a bare false so the trace can say which refusal fired. */
export type FixerNotTruncated =
  /** No continuation surface at all (a harness without `ReviewDeps.continueSession`). */
  | "no-seam"
  /** The switch is at the literal `"0"`. */
  | "switch-off"
  /** pi-rukas ended the child: a budget/infra stop that `runFixer` already routed. */
  | "killed"
  /** The step's own ceiling had already fired — the continuation would be born aborted. */
  | "budget-fired"
  /** No assistant turn to read a stop reason off (a result rebuilt from disk). */
  | "no-final-turn"
  /** The final turn did not end on the output cap. */
  | "not-length"
  /** The child recorded a write-class call: a fixer that edited and never committed is the fold's
   *  problem, not this one, and re-asking it would pay twice for bytes that already exist. */
  | "wrote"
  /** The child's session file is not there to continue. */
  | "no-session";

/**
 * Is this fixer's result one that was cut off before it wrote anything?
 *
 * Every field is read from what the CHILD recorded. The order is the contract: a kill cause first,
 * then the budget, then the stop reason, then the write calls. A `"length"` stop on a child the
 * harness itself killed is impossible by construction (`killCause` is stamped on a SIGTERM the
 * parent sent, and the child never got to close its turn), but the branch still goes first so a
 * future field that lets the two coexist cannot quietly make a budget kill look like a provider cap.
 */
export function fixerWasTruncated(
  result: DispatchResult,
  deps: { seam: boolean; budgetFired: boolean },
): FixerTruncation {
  if (!deps.seam) return notTruncated("no-seam");
  if (!leanFixerTruncationReaskEnabled()) return notTruncated("switch-off");
  // R2 — a self-kill is never a provider fault, and never a truncation either. `runFixer` already
  // routed it (`budget.fired` → a stop; `throwIfDispatchFailed` → a throw), so reaching here with a
  // kill cause is a path that has not been routed; the safe reading is today's, with no child spent.
  if (result.killCause !== undefined) return notTruncated("killed");
  // The clock BEFORE the money: an aborted continuation answers nothing, and today's handback is
  // what the step would have said anyway — with the child's tokens spent for nothing.
  if (deps.budgetFired) {
    // The refusal is named so an operator reading a wave trace can tell "the step's own ceiling had
    // already fired" from "nobody looked": that one is a budget question and the rest are provider
    // questions, and a silent no answers neither.
    traceWarn(`fixer-truncation: no continuation — the step's budget had already fired`);
    return notTruncated("budget-fired");
  }
  const stop = result.stopReason;
  // Absent is not "end_turn": a result with no recorded stop reason is a result nobody watched
  // finish, and guessing truncation from silence is how a gate starts reporting a confident wrong
  // answer. Same for a non-string the JSON carried.
  if (typeof stop !== "string") return notTruncated("no-final-turn");
  if (stop !== TRUNCATED_STOP_REASON) return notTruncated("not-length");
  // Silence is never a pass in the other direction either: `toolUses` is empty for a child killed
  // mid-flight and `observedToolCalls` is the live count that covers it. A child that made calls but
  // whose replay carried none is a child whose writes nobody saw, so it is not vouchable as
  // write-free and gets no continuation.
  const observed = result.observedToolCalls;
  if (observed !== undefined && result.toolUses.length === 0 && observed > 0)
    return notTruncated("wrote");
  if (madeWriteCall(result.toolUses)) return notTruncated("wrote");
  return { truncated: true, outputTokens: result.usage?.output ?? 0 };
}

/**
 * The continuation's cost row, from what the resumed child REPORTED.
 *
 * Built here rather than handed in by the seam, so a wave cannot bill a continuation on numbers its
 * own case typed: `role` and `runId` come from the wave, the counts from the child. A child that
 * answered no final turn has no usage to report and costs zero, the same reading `dispatchUsageRow`
 * gives a child that never started — an unrecorded number is unknown, not a small one. `ok` follows
 * the child's own verdict: a failure outcome is not a child that finished.
 */
export function continuationRow(
  outcome: {
    ok: boolean;
    ms?: number;
    usage?: DispatchUsageRow["usage"];
    stopReason?: string;
  },
  role: string,
  runId: DispatchUsageRow["runId"],
): DispatchUsageRow {
  return {
    role,
    ms: outcome.ms ?? 0,
    ok: outcome.ok === true,
    usage: outcome.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      turns: 0,
      toolCalls: 0,
      toolErrors: 0,
    },
    runId,
    ...(typeof outcome.stopReason === "string" ? { stopReason: outcome.stopReason } : {}),
  };
}

/**
 * The token count the truncation clause quotes: the CUT child's own output, not the wave's largest.
 *
 * Read off the rows the wave billed rather than kept in a closure: `runFixer` appends the fixer's row
 * on both arms, so a `developer` row IS a child whose cut this reason may name. Scanning backwards
 * would land on the continuation, which is the child that was NOT cut — quoting it would tell an
 * operator a number belonging to a different turn. The truncated child is the FIRST fixer row of the
 * wave, and the continuation (when there was one) is the row after it. A wave that billed no fixer row
 * — which cannot happen on the arm that reaches here, and the reason a missing one answers zero rather
 * than guessing — names zero, the honest "nobody observed any" the row's own default gives.
 */
export function truncatedFixerOutputTokens(rows: DispatchUsageRow[]): number {
  for (const row of rows) {
    if (row.role === FIXER_ROLE) return row.usage.output;
  }
  return 0;
}

function notTruncated(reason: FixerNotTruncated): FixerTruncation {
  return { truncated: false, reason };
}

/** The continuation's bound: the smaller of the fixer's own ceiling and whatever the step's armed
 *  budget still allows. `undefined` bound (no armed minutes) means the fixer's ceiling alone. */
export function continuationBoundMs(budget: BudgetArms, fixerBoundMs: number): number {
  const armed = budget.opts.childBoundMs;
  return armed === undefined ? fixerBoundMs : Math.min(fixerBoundMs, armed);
}

/** The one prompt the continuation gets. Short on purpose: the resumed child has the whole
 *  conversation already — the diff it read, the findings it was handed, the tree it was named — and
 *  a long second prompt re-briefs a child that is not missing the brief, it is missing the tokens.
 *
 *  It says three things and nothing else: that the last turn was cut, that nothing was edited yet,
 *  and what is still owed. `findings` is reviewer-authored prose crossing back into the child's own
 *  context, so it is fenced and bounded by `fenceText` — the same helper the fixer's own brief uses
 *  for the same list — so one `### heading` inside a finding stays text rather than becoming a
 *  section of this brief the step never wrote. */
export function continuationPrompt(issue: number, findings: string): string {
  return `Your previous turn was cut off at the model's output-token limit before you made a single edit (issue #${String(issue)}), so nothing has changed yet and the work is not lost — this is the same session.

Do not re-read the diff, the issue or the tree: you already read them. Go straight to the smallest edit that answers what is outstanding.

## Still outstanding

${fenceText(findings, 4_000)}

Fix them highest severity first, commit each one as you finish it, and keep this turn short enough to finish.`;
}

/**
 * The clause naming a fixer whose last turn was cut at the output-token limit, appended to the
 * no-change cause when the wave spent its ONE continuation and the head still did not move.
 *
 * It is a SUFFIX rather than a different cause, and `CAUSE_NO_CHANGE` stays the sentence's head, for
 * two reasons: the cause is matched on all three surfaces that print it (this throw, the handback's
 * cause line, the headless `failure.message`), so a reader keyed on the existing phrase must keep
 * finding it; and the token count is the fact an operator needs in order to tell a model that hit its
 * provider's cap from a fixer that read everything and decided to change nothing. The clause sits at
 * the END of a cause this step's own renderer clips from the end, so it is short by construction and
 * pinned inside the kept span by the truncation suite.
 */
export function truncationClause(outputTokens: number): string {
  return ` — the fixer's last turn was cut off at the output-token limit (${String(
    outputTokens,
  )} tokens) before any edit, and one continuation changed nothing`;
}
