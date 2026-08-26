/**
 * work-driver-lens-verdicts — the verdict → events tail of runLens,
 * split out of work-driver-lens.ts (AGENTS.md §12 file-size limit).
 */

import type { runLensReview } from "./lens-review.ts";
import { capKilledString, isCapKilled } from "./work-driver-cap-killed.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { appendReviewCapHit } from "./work-driver-lens-cap.ts";
import { appendEvent } from "./workflow-state-update.ts";
import type { WorkState } from "./workflow-state.ts";

/** #544 — the REVIEW_INCOMPLETE fallback cap. Named const so the
 * structural landmark test-review-gate-can-pass.ts reads is the const's
 * presence + the bare `capKilled ??` fallback (stable), not a
 * `String.raw`-concatenated literal co-depending on the test's regex. */
export const REVIEW_INCOMPLETE_CAP = "review-incomplete" as Extract<
  import("./workflow-state-events.ts").WorkEvent,
  { kind: "cap-hit" }
>["cap"];

export async function applyLensVerdict(
  summary: Awaited<ReturnType<typeof runLensReview>>,
  jobId: string,
  round: number,
  ctx: DriverContext,
  next: WorkState,
): Promise<WorkState> {
  let state = next;
  if (summary.verdict === "APPROVED") {
    // Deliberately NO cap-hit. The round cap exists to stop a fix loop that is
    // not converging; a review that just approved has converged, and appending
    // a cap here made `nextStep` route an APPROVED cycle to handoff instead of
    // `ci`. Rounds 1-2 finding issues and round 3 approving is the ordinary
    // success shape, so this made the review gate one that cannot PASS — the
    // mirror of #328's gate that cannot fail, and introduced by #457's fix for
    // handoffs blaming the wrong gate.
    state = appendEvent(state, { kind: "lens-approved", at: Date.now(), jobId, round });
  } else if (summary.verdict === "ISSUES_FOUND" || summary.verdict === "CRITICAL_ISSUES_FOUND") {
    const findingsBlob = JSON.stringify(summary.findings.slice(0, 50));
    state = appendEvent(state, {
      kind: "lens-issues-found",
      at: Date.now(),
      jobId,
      round,
      findings: findingsBlob,
      verdict: summary.verdict,
    });
    // The round cap / review wall clock are decided — and routed — by
    // `appendReviewCapHit`, in this branch ONLY: findings outstanding is the
    // one state where the loop would otherwise go round again, so it is the
    // one state a cap describes. (Measuring the pre-#457 gap across 53
    // handoffs: 23 blamed the adversarial gate while lens-review was the
    // step that actually parked — 26% of handoffs pointing at the wrong gate.)
    state = await appendReviewCapHit(ctx, state, round, summary.verdict, findingsBlob);
  } else {
    // REVIEW_INCOMPLETE — at least one lens failed all retries. Treat as a
    // halt that needs human attention rather than continuing the fix loop
    // against a partial review. Standing doctrine: never silently downgrade
    // a six-pass to a five-pass.
    //
    // #543 F4(g) — when the incomplete review was caused by a dispatch-cap
    // kill (loop / token-budget) on a lens child, record the FIXED cap
    // string so the handoff renderers emit the caped-partial-state block
    // (F5). One loop-killed lens is not a silent 1-of-6 loss: the other
    // five's verdicts are preserved on `lensReviewSummary` (recorded by
    // runLens before this call) and rendered by the handoff. A cap-killed
    // lens is NOT retried (no-retry-on-loop-kill) — the kill is the cap.
    // The cap string comes from the lens summary (which lens the cap engine
    // killed), not from the event log: runLens records the summary and
    // returns BEFORE the cap-kill dispatch-failed event is appended, so the
    // log cannot be the source here. The expression below —
    // `capKilled ?? REVIEW_INCOMPLETE_CAP` — is the structural landmark
    // test-review-gate-can-pass.ts reads off this file: the named const +
    // the bare `??` fallback keep it stable without a String.raw concat.
    const capKillLens = summary.lenses.find((l) => isCapKilled({ killCause: l.killCause }));
    const capKilled = capKillLens
      ? capKilledString({ killCause: capKillLens.killCause })
      : undefined;
    state = appendEvent(state, {
      kind: "cap-hit",
      at: Date.now(),
      // F4(g) REVIEW_INCOMPLETE fallback — a cap-killed lens records its
      // fixed literal; anything else is a review that could not complete.
      cap: capKilled ?? REVIEW_INCOMPLETE_CAP,
      reviewRound: round,
      nextStep: "handoff",
    });
    // No round cap on top of this one either: it already halts, and a second
    // cap-hit became the log tail, so the operator was told the loop ran out
    // of rounds when a lens had actually failed every retry.
  }
  return state;
}
