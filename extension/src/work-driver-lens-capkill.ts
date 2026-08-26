/**
 * work-driver-lens-capkill — the #543 F4(g) dispatch-cap-kill record for
 * the lens-review step. Split out of work-driver-lens.ts (AGENTS.md §12
 * file-size limit).
 *
 * A cap-killed lens child (loop detector / token budget) is a distinct
 * event: the driver records it as a dispatch-failed so the step router,
 * the F5 checkpoint and the handoff renderers see the structured cause
 * exactly like any other step's dispatch failure — one loop-killed lens is
 * not a silent 1-of-6 loss.
 */

import type { LensReviewSummary } from "./lens-review.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

export function lensCapKillEvent(
  summary: LensReviewSummary,
  jobId: string,
  round: number,
  ms: number,
  at: number,
): WorkEvent | undefined {
  const capKill = summary.capKill;
  if (!capKill) return undefined;
  const killedLens =
    summary.lenses.find((l) => l.killCause === capKill) ?? summary.lenses.find((l) => l.blocked);
  // #543 — the structured trigger evidence (tool+count for loop, budget+used
  // for token-budget) is carried on the event so the step router can persist
  // it on `pipelineState.capEvidence` (the F4(j) render path). Absent when
  // the lens summary did not thread it (pre-#543 lens summary shape).
  const ev = summary.capKillEvidence;
  return {
    kind: "dispatch-failed",
    step: "lens-review",
    role: "code-review-specialist",
    jobId,
    label: killedLens ? `lens:${killedLens.lens}` : `lens-review×6 (round ${round})`,
    ms,
    at,
    // #544 — the cap engine kills with SIGTERM, so the observed exit is 143
    // (128 + 15). The previous hardcoded 1 made this event structurally
    // indistinguishable from a genuine exit-1 failure to consumers branching
    // on exitCode; `killCause` remains the authoritative signal.
    exitCode: 143,
    killCause: capKill,
    errorTail: `killed by pi-ensemble (${capKill === "loop" ? "loop detected" : "token budget crossed"}) — self-inflicted cap, not a provider fault`,
    usage: summary.usage,
    ...(ev && capKill === "loop" && "tool" in ev
      ? { loopEvidence: { tool: ev.tool, count: ev.count } }
      : {}),
    ...(ev && capKill === "token-budget" && "budget" in ev
      ? { tokenBudget: { budget: ev.budget, used: ev.used } }
      : {}),
  };
}
