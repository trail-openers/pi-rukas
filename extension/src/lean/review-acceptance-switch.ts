/**
 * lean/review-acceptance-switch — the off lever for the review step's executed
 * acceptance table. The rule it governs lives in `review-acceptance.ts`; this
 * module owns only the lever, and no renderer consults it — the step's call sites
 * are the only readers.
 *
 * Read at CALL time: every lean smoke file runs in one `bun` process and pins its
 * own arms with `withEnv`, so a load-time read would let one file's pin disable
 * the next file's arm.
 */

/** Whether the review step composes the executed acceptance table at all. Only the
 * literal `"0"` takes it out; unset or any other value keeps it. With `"0"` the two
 * reviewer briefs render byte-identically to the render before the table existed,
 * no PR comment is posted, and `assertHeadIsVerified` does not run. */
export function leanReviewAcceptanceEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_REVIEW_ACCEPTANCE !== "0";
}
