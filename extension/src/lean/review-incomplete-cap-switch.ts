/**
 * lean/review-incomplete-cap-switch — the ONE reader of the switch that decides whether a
 * lean run whose review stopped with lanes unjudged gets its own cap.
 *
 * A lean run that reaches `publish` and does not merge leaves on exit 10 whatever its
 * review did, and until now the document's `cap` said `awaiting-human-merge` for every
 * such run whose PR stood ready — including the one whose review step stopped at its own
 * clock or the cycle deadline with lenses never judged. A host that reads the cap to
 * decide whether to merge therefore could not tell "six lenses judged this head" from
 * "three of six never ran", and the fact that separates them is already in the run's
 * record (the `reviewBound` a stop writes).
 *
 * On (the default) that run reports the published fixed cap `review-incomplete` instead,
 * and the document carries `issues[].reviewComplete`. Only the literal `"0"` takes both
 * back: the cap goes to `awaiting-human-merge` exactly as it read before, and the field
 * is not written at all — no key holding `undefined`, so the off arm is byte-for-byte the
 * document this build wrote before the cap existed. That is what makes the change safe to
 * ship on by default, and `test-headless-work-lean-review-incomplete-cap-switch.ts` pins
 * it against a serialised pre-change golden.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file runs in one
 * bun process and pins off/on arms with a `withSwitch` helper, so a load-time read would
 * let one file's pin silently change the next file's arm.
 */

/** Whether an unjudged review gets `review-incomplete` and the `reviewComplete` field. */
export function leanReviewIncompleteCapEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_CAP !== "0";
}
