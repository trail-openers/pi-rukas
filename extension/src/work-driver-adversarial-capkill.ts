/**
 * work-driver-adversarial-capkill — the #543 F4(g) cap-kill → cap-hit
 * adapter for the adversarial gate, split from work-driver-adversarial.ts
 * (AGENTS.md §12 file-size limit).
 *
 * A loop / token-budget cap kill is a CAP, not an infra failure. It parks
 * with the fixed-literal cap (`loop-detected` / `token-budget`) INSTEAD of
 * `adversarial-infra-failure` — the two are distinct events, and a cap kill
 * is never retried.
 *
 * The synthesized loop result carries no errorTail, so the structured signal
 * a cap kill leaves on the workstream is its `killCause` (threaded through
 * from the inner spawn by `infraFailureResult`). A genuine infra failure
 * (provider severance, generic crash) has no cap killCause, so the check is
 * precise: only loop / token-budget kills take the cap path.
 */

import type { AdversarialOutcome } from "./work-driver-adversarial-types.ts";
import { capKilledString } from "./work-driver-cap-killed.ts";
import type { CapEvidence } from "./workflow-state-cap.ts";
import type { WorkEvent } from "./workflow-state.ts";

/**
 * The fixed-literal cap-hit (+ trigger evidence) for a cap-killed
 * adversarial workstream, or undefined when the outcome is not a cap kill.
 *
 * #543 F4(j) — the structured trigger evidence so the handoff's `explainCap`
 * renders WHAT looped (or how much was spent) rather than the fallback
 * sentence. Absent when the inner spawn did not thread it (pre-#543 shape,
 * or a workstream that failed for an unrelated reason before the cap
 * evidence was captured).
 */
export function capHitForCapKill(
  o: AdversarialOutcome,
  reviewRound: number,
):
  | {
      event: Extract<WorkEvent, { kind: "cap-hit" }>;
      evidence?: CapEvidence;
    }
  | undefined {
  const killCause = o.killCause;
  const cap = capKilledString({ killCause });
  if (!o.ok && (o.infra || o.threw) && cap) {
    const evidence: CapEvidence | undefined = o.loopEvidence
      ? { kind: "loop", tool: o.loopEvidence.tool, count: o.loopEvidence.count }
      : o.tokenBudget
        ? {
            kind: "token-budget",
            budgetTokens: o.tokenBudget.budget,
            usedTokens: o.tokenBudget.used,
          }
        : undefined;
    return {
      event: {
        kind: "cap-hit",
        at: Date.now(),
        cap,
        reviewRound,
        nextStep: "handoff",
        role: "adversarial-developer",
      },
      ...(evidence ? { evidence } : {}),
    };
  }
  return undefined;
}
