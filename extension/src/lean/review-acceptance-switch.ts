/**
 * lean/review-acceptance-switch — the switch on the review step's executed
 * acceptance table.
 *
 * One reader, read at CALL time, like every other lean knob: every lean smoke
 * file runs in one `bun` process and pins its own arms with `withEnv`, so a
 * load-time read would let one file's pin disable the next file's arm.
 *
 * The rule this switch governs lives in `review-acceptance.ts`; this module owns
 * only the off lever, so a reader of the renderer never has to wonder whether the
 * knob is consulted there as well.
 */

/** Whether lean's review step composes the executed acceptance table at all.
 * Only the literal `"0"` takes it out; unset or any other value keeps it. With
 * `"0"` the two reviewer briefs render byte-identically to the render before the
 * table existed, no PR comment is posted, and the entry guard in `review-entry.ts`
 * does not run. */
export function leanReviewAcceptanceEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_REVIEW_ACCEPTANCE !== "0";
}
