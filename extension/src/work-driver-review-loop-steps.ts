/**
 * work-driver-review-loop-steps — the steps a re-review passes through
 * between two `lens-review` entries.
 *
 * One list, two readers, both of which ask the same question ("has anything
 * that changes or re-reviews the code happened since this verdict?"):
 * `reviewConcluded` (work-driver-draft-pr.ts, the ready mark point) and
 * `reviewRerunPending` (work-driver-draft-rearm.ts, the re-arm trigger). They
 * used to carry their own copies, and a list that drifts between the two
 * decides differently about whether the review is over — one marks the PR
 * ready while the other re-arms it. Lives in its own module because the two
 * consumers import each other (the re-arm reuses the ready path's helpers), so
 * neither can own a constant the other needs at module-initialisation time.
 */
export const WORK_DRIVER_REVIEW_LOOP_STEPS = [
  "develop",
  "adversarial",
  "commit-pr",
  "lens-fix",
  "lens-review",
] as const;
