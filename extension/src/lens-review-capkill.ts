import type { LensReviewSummary } from "./lens-review.ts";
import type { LensRunResult } from "./lens-review.ts";

/**
 * #543 — the cap-kill tail of the lens summary: which lens child was
 * killed (loop / token-budget) and its structured trigger evidence, so
 * the driver can persist `capEvidence`. Split from runLensReview
 * (AGENTS.md §12 file-size limit).
 * budget) is surfaced on the summary so the driver emits the fixed-literal
 * cap-hit (F4g) instead of a silent 1-of-6 loss.
 */
export function capKillSummary(
  lensResults: LensRunResult[],
): Pick<LensReviewSummary, "capKill" | "capKillEvidence"> {
  const capKillLens = lensResults.find(
    (r) => r.killCause === "loop" || r.killCause === "token-budget",
  );
  const capKill = capKillLens?.killCause;
  const capKillEvidence =
    capKillLens?.killCause === "loop" && capKillLens.loopEvidence
      ? capKillLens.loopEvidence
      : capKillLens?.killCause === "token-budget" && capKillLens.tokenBudget
        ? capKillLens.tokenBudget
        : undefined;
  return {
    ...(capKill ? { capKill } : {}),
    ...(capKillEvidence ? { capKillEvidence } : {}),
  };
}
