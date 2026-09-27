import type { DispatchResult } from "./types.ts";
import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";

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
