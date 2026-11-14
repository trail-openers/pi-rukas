/**
 * lens-review-incomplete-switch — the ONE reader of the switch that decides
 * whether a `REVIEW_INCOMPLETE` lens row may serve as the automatic delta base.
 *
 * An incomplete round ran no lens (or ran some and lost others), yet its row
 * carries a real `headSha`, and `resolveDeltaSince` took that SHA as the commit
 * "this branch was last reviewed at". The next dispatch — same head, no new
 * commit — therefore resolved an empty automatic delta and reported
 * "NO REVIEW — no changes since the last lens review" instead of reviewing the
 * branch, which is how a round that never ran makes its head look reviewed. The
 * reader is checked BEFORE the same-head `noReview` arm for the same reason:
 * the order is the whole fix, and an arm that consults the head first restores
 * the refusal while every other rule still reads correct.
 *
 * `PI_ENSEMBLE_LENS_INCOMPLETE_FULL=0` is the operator's escape hatch back to
 * the old behaviour: the incomplete row is the delta base again, and the
 * same-head round is refused as a no-review. It exists for a host that decides
 * re-reviewing after a failed round costs more than the coverage it lost — the
 * judgement is theirs, not the delta reader's. Only the literal `"0"` turns the
 * rule off; unset and any other value leave it on.
 *
 * The env var is read at CALL time, not at module load: the offline smoke files
 * run in one bun process each and pin off/on arms with `withEnv`, so a
 * load-time read would let one file's pin disable the rule in the next.
 */

/** Whether an incomplete lens row is skipped as the automatic delta base. */
export function lensIncompleteForcesFull(): boolean {
  return process.env.PI_ENSEMBLE_LENS_INCOMPLETE_FULL !== "0";
}
