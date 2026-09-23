/**
 * work-driver-explain-detect-caps — cap-hit explanations for the self-kill
 * cap family (#543 loop detector, #543 token budget, #754 plan-timeout).
 * Split from work-driver-explain.ts so that file sits under the 500-line cap
 * with headroom for new caps; the content here is the verbatim former case
 * bodies of work-driver-explain.ts.
 */

import type { WorkEvent, WorkState } from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

/**
 * Explains the #543 dispatch-cap family (`loop-detected`,
 * `token-budget`); the dispatch is exhaustive, so an unknown cap can
 * never land here.
 */
export function explainDetectCaps(cap: Cap, state: WorkState): string {
  switch (cap) {
    case "plan-timeout": {
      // #754 — the plan step's own wall-clock bound expired on the primary
      // plan dispatch and its one-shot corrective re-dispatch did not
      // recover. The turn count and cache volume the planner burned ride on
      // the dispatch-failed event's usage (decision 2: a killed dispatch
      // never emits dispatch-completed), so name both here — the incident
      // behind this bound was a 266-turn, ~38 MB cache-read planning loop
      // that cost 120 of the cycle's 140 minutes.
      const killed = [...state.eventLog]
        .reverse()
        .find(
          (e): e is Extract<WorkEvent, { kind: "dispatch-failed" }> =>
            e.kind === "dispatch-failed" && e.step === "plan" && Boolean(e.killCause),
        );
      const turns = killed?.usage?.turns;
      const cacheRead = killed?.usage?.cacheRead;
      const turnsBit = turns ? ` It ran ${turns} turn(s)` : "";
      const cacheBit = cacheRead
        ? ` and ${Math.round(cacheRead / 1000).toLocaleString()}k cache-read tokens`
        : "";
      return `the plan step's own wall-clock bound expired — the primary planning dispatch outlived its bound (PI_ENSEMBLE_PLAN_TIMEOUT_MS, default 30 min; the same bound the compiled /plan pipeline adopts for the same activity), and the corrective re-plan the driver attempted did not recover.${turnsBit}${cacheBit} This is a bound on PLANNING, not on the issue: planning either converges quickly or is not converging. The global 2 h spawn backstop is unchanged for every other step. Re-run with \`/work N --restart\`, or set PI_ENSEMBLE_PLAN_TIMEOUT_MS if the planning genuinely needs more than 30 minutes`;
    }
    case "loop-detected": {
      // #543 — the F1 loop detector killed a repeating child. The trigger
      // evidence lives in pipelineState.capEvidence; render it so the
      // operator sees WHICH call repeated (the #296 structured-kill contract
      // — a bare cause cannot say what looped).
      const ev = state.pipelineState.capEvidence;
      const loop = ev && ev.kind === "loop" ? ev : undefined;
      const tool = loop?.tool ? `repeating \`${loop.tool}\`` : "repeating the same tool call";
      const count = loop?.count ? ` ${loop.count} times` : "";
      const range = loop?.turnRange ? ` (turns ${loop.turnRange[0]}–${loop.turnRange[1]})` : "";
      const fp = loop?.fingerprint ? ` with normalised args \`${loop.fingerprint}\`` : "";
      return `a subagent was looped on — it kept re-issuing the same ${tool}${count}${range}${fp}, so the harness killed it before it burned more budget (override: PI_ENSEMBLE_DISPATCH_CAPS / PI_ENSEMBLE_CAP_KILL_GRACE_MS). This is a detected loop, NOT a provider fault: retrying the same prompt would loop again, so the fix is a changed approach (or a tighter prompt), not a re-dispatch`;
    }
    case "token-budget": {
      // #543 — the F6 cumulative token budget was crossed. The budget and the
      // spend at the kill live in pipelineState.capEvidence.
      const ev = state.pipelineState.capEvidence;
      const budgetEv = ev && ev.kind === "token-budget" ? ev : undefined;
      const budget = budgetEv
        ? ` ${Math.round(budgetEv.budgetTokens).toLocaleString()} tokens`
        : "";
      const used = budgetEv ? ` (spent ${Math.round(budgetEv.usedTokens).toLocaleString()})` : "";
      return `a subagent crossed its cumulative token budget${budget}${used} — a cost cap, not a provider fault (override: PI_ENSEMBLE_TOKEN_BUDGET_<ROLE>). The budget bounds context-driven spend; raise it only if the work genuinely needs the context, or re-dispatch with a tighter prompt so it fits`;
    }
    default:
      return `unhandled detect-cap: ${cap}`;
  }
}
