/**
 * lean/review-problem-switch — the review seats' statement of the problem.
 *
 * One reader, read at CALL time: every lean smoke file runs in one `bun`
 * process and pins its own arms with `withEnv`, so a load-time read would let
 * one file's pin disable the next file's arm.
 */

/** Whether the lean review criteria section opens with the spec's `problem`.
 * Only the literal `"0"` takes the statement out; unset or any other value
 * keeps it. Read at call time, like `leanReviewSpecSplitEnabled` beside it. */
export function leanReviewProblemEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_REVIEW_PROBLEM !== "0";
}
