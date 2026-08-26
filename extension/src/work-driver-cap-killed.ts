/**
 * work-driver-cap-killed — the shared predicate for the two new
 * dispatch-cap kill causes (#543 F1/F6) and the cap-string mapping.
 *
 * `capKilled` matches the two dispatch-cap kill causes (loop /
 * token-budget) regardless of which step emitted them. It is the
 * single source of truth for:
 *
 *   - the step-router's cap-string synthesis (develop / lens /
 *     adversarial HALT paths),
 *   - `runHandoff`'s mid-flight-halt check (these caps set
 *     `status: 'aborted'` like developer-timeout / step-failed),
 *   - `runLens`'s REVIEW_INCOMPLETE branch (a loop-killed lens is
 *     not a silent 1-of-6 loss — the cap string is recorded),
 *   - the handoff renderers' caped-partial-state gate (F5).
 *
 * The matcher takes `{ killCause }` — the shape shared by both a
 * `DispatchResult` (spawn.ts's structured kill) and a `dispatch-failed`
 * WorkEvent (the state-file record) — so the step router can feed it an
 * event without a structural cast.
 */

import type { LensReviewSummary } from "./lens-review.ts";
import type { DispatchResult } from "./types.ts";

/** #543 — the two dispatch-cap kill causes. Matched on the
 * `DispatchResult.killCause` set by the cap engine in spawn.ts (F1/F6). */
export const DISPATCH_CAP_KILL_CAUSES = ["loop", "token-budget"] as const;

/** #543 — the two dispatch-cap cap strings. Fixed literals, NOT
 * template-literal shapes (see workflow-state-events.ts). */
export const DISPATCH_CAP_STRINGS = ["loop-detected", "token-budget"] as const;

type CapString = (typeof DISPATCH_CAP_STRINGS)[number];

/** True when the dispatch was killed by a dispatch-cap (loop or
 * token-budget). These are the ONLY kill causes that route through
 * the F5 caped-partial-state checkpoint + handoff rendering. */
export function isCapKilled(result: { killCause?: string }): boolean {
  const cause = result.killCause;
  return (
    typeof cause === "string" && (DISPATCH_CAP_KILL_CAUSES as readonly string[]).includes(cause)
  );
}

/** The cap string for a dispatch-cap kill, or undefined. Accepts a
 * `DispatchResult`, a `dispatch-failed` WorkEvent, or any object carrying a
 * `killCause` — ONE place owns the killCause → cap-string mapping (the step
 * router, the adversarial / lens cap-kill adapters and the checkpoint all
 * route through here so the two fixed literals cannot drift apart). Returns
 * the FIXED literal so the caller can assign it to a cap-hit `cap` without
 * a cast. */
export function capKilledString(result: { killCause?: string }): CapString | undefined {
  if (!isCapKilled(result)) return undefined;
  return result.killCause === "token-budget" ? "token-budget" : "loop-detected";
}

/** True when the six-pass lens review returned REVIEW_INCOMPLETE. */
export function isReviewIncomplete(summary: LensReviewSummary): boolean {
  return summary.verdict === "REVIEW_INCOMPLETE";
}
