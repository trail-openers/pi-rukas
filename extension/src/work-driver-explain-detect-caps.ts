/**
 * work-driver-explain-detect-caps — cap-hit explanations for the #543
 * dispatch-cap family (loop detector, token budget). Split from
 * work-driver-explain.ts so that file sits under the 500-line cap with
 * headroom for new caps; the content here is the verbatim former case
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
