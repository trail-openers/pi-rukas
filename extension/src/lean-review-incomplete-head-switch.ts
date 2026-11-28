/**
 * lean-review-incomplete-head-switch — the ONE reader of the switch on #2667.
 *
 * A `review` step that throws over a head the run's own gate certified used to end the
 * run on the engine's bare error path: the reporting step never ran, so the certified
 * head was neither shipped nor named. On, the engine routes that run through the
 * reporting step, which rewinds or refuses exactly as a `fixed` review's handback does,
 * and the run still ends handed-back at exit 10. Off, the run is stamped where it
 * stands, which is the byte-identical behaviour of the release before this knob: the
 * `handback` entry the routed visit writes is the only record the feature can add, and
 * `errorOutcome`'s clause is the only field it can grow.
 *
 * Only the literal `"0"` turns it off, read at CALL time, so an operator may move the
 * knob between runs of the same build and an accidental empty value is never read as
 * off. The shape is the one every sibling lean switch uses (`v !== "0"`).
 */

/** Whether a review that did not complete hands its run to the reporting step. */
export function leanReviewIncompleteHeadEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_HEAD !== "0";
}
