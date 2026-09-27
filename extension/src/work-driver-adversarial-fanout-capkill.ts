import type { DispatchResult } from "./types.ts";
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";

/**
 * #543 — the cap-kill fields of an AdversarialOutcome: the killCause
 * (loop / token-budget) and its structured trigger evidence from
 * the inner spawn's DispatchResult. Empty when the result carries no cap
 * kill. Split from runOne's return (AGENTS.md §12 file-size limit).
 */
export function capKillOutcomeFields(result: DispatchResult): Partial<AdversarialOutcome> {
  if (result.killCause === "loop") {
    return {
      killCause: "loop",
      ...(result.loopEvidence ? { loopEvidence: result.loopEvidence } : {}),
    };
  }
  if (result.killCause === "token-budget") {
    return {
      killCause: "token-budget",
      ...(result.tokenBudget ? { tokenBudget: result.tokenBudget } : {}),
    };
  }
  return {};
}
