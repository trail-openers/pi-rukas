/**
 * work-driver-failure-policy — the per-step failure policy table (PR5).
 *
 * Split out of work-driver-context.ts (500-line cap). `work-driver-context`
 * re-exports these names, so importers keep their path. The step router
 * consults the policy when a step body's tail is a dispatch failure.
 */

import type { WorkStep } from "./workflow-state.ts";

/**
 * Per-step failure policy (PR5 halt-cascade prevention).
 *
 * Background: PR #239 driver continued past `dispatch-failed` because
 * `nextStep()` has no branch for that event kind — the linear table just
 * advanced. In one measured cycle, a developer SIGTERM at 30 min cascaded into
 * 2h31m of adversarial review against partial work, then 40 min of
 * provider-timeouting handoff. ~4 hours wasted, opaque outcome.
 *
 * The fix is a routing classifier: when a step body's tail event is
 * `dispatch-failed` (or `dispatch-failed-provider`), the driver loop
 * consults this table BEFORE calling `nextStep()`:
 *
 *  - **HALT**: synthesise a cap-hit `step-failed:<step>` (or the special
 *    `spawn-backstop` shape when the errorTail matches the spawn
 *    timeout marker), set `status='aborted'`, route to handoff. There
 *    is no useful downstream past a HALT failure.
 *  - **RETRY_ONCE**: re-run the same step body once. Idempotent steps
 *    (adversarial loop against a stable diff, lens-review 6-way fanout)
 *    can absorb transient provider transport errors. Second failure
 *    HALTs via the same path.
 *  - **DEGRADED_OK**: the existing fall-through to `nextStep()` is fine.
 *    Step-back (informational) and the terminal steps (handoff, merged)
 *    fit here.
 *
 * The verdict paths (adversarial-rejected → cap-hit handoff, the lens
 * round cap → whatever destination `appendReviewCapHit` recorded on the
 * event) are unchanged — those route correctly already. This table only
 * governs dispatch-failed at the step level.
 */
export type StepFailurePolicy = "HALT" | "RETRY_ONCE" | "DEGRADED_OK";

export const STEP_FAILURE_POLICY: Record<WorkStep, StepFailurePolicy> = {
  // No spec foundation → plan/branch/develop run blind.
  explore: "HALT",
  // No workstreams → silent regression to single-task develop without
  // out-of-scope fences (PR3 doctrine violated).
  plan: "HALT",
  // No branch → develop edits HEAD, commit-pr has nothing to push, CI
  // has nothing to watch. Was the empirical root of issue #553's first
  // run cascade.
  branch: "HALT",
  // Partial uncommitted work after SIGTERM is not adversarial-reviewable.
  // For N>1 workstreams: HALT if ANY branch failed (runDevelop's
  // Promise.allSettled aggregate is the failure signal).
  develop: "HALT",
  // Internal 3-round loop is idempotent against a stable diff; transient
  // transport is realistic. Second failure HALTs. The
  // REJECTED-after-3-rounds verdict path already routes correctly to
  // handoff via cap-hit — unchanged.
  adversarial: "RETRY_ONCE",
  // No PR → lens-review wastes hours on uncommitted work, CI retries
  // to no purpose. Was a contributing factor in the #553 spin.
  "commit-pr": "HALT",
  // 6 lens children against a stable diff are idempotent. Cannot ship
  // code that bypassed lens-review.
  "lens-review": "RETRY_ONCE",
  // Same shape as develop — partial fix work cannot meaningfully re-
  // enter adversarial→lens.
  "lens-fix": "HALT",
  // Output is informational; an empty step-back reply still produces a
  // useful handoff.
  "step-back": "DEGRADED_OK",
  // Silently marking a cycle merged when CI was never checked is the
  // worst possible outcome. Marker-missing-but-ops-ran is already
  // handled via ciRetryCount (PR2).
  ci: "HALT",
  // Must never halt the loop — IS the loop terminator. PR5 hardens
  // handoff itself via in-process gh fallback (see runHandoff).
  handoff: "DEGRADED_OK",
  // PR10: was DEGRADED_OK while runMerged was a 0ms state mutation; now
  // it actually dispatches ops to run `gh pr merge`, which CAN fail
  // (auth, branch protection, conflicts). Silently flipping status to
  // 'merged' on dispatch failure would be exactly the bug PR10 fixes
  // (the empirical /work 561/562 case: driver reported MERGED ✓ while
  // PRs sat OPEN on GitHub). HALT routes the failure through cap-hit
  // 'step-failed:merged' → handoff so the operator merges manually.
  merged: "HALT",
};
