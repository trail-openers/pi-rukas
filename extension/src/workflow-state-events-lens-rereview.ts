/**
 * workflow-state-events-lens-rereview — #1537: the fact that a fix wave has been
 * answered, so its round is the loop's LAST WORD.
 *
 * Split from `workflow-state-events.ts` for the AGENTS.md §12 500-line gate (the
 * same seam as the other `workflow-state-events-*` leaves). It has no `step`
 * field — it names the review round instead — so the schema validator's step
 * check skips it.
 *
 * WHY THIS EVENT EXISTS. The review loop used to end on a counter: three rounds,
 * whichever way they went. Under one-full-review / one-fix-wave /
 * one-scoped-re-review the loop ends on a SHAPE — the round that answers a fix
 * wave is terminal — and "answered a fix wave" is a fact about a dispatch that
 * has already happened. `dispatch-started{step: lens-fix}` is almost that fact,
 * but a fixer that produced no commit still dispatched one, and the re-review of
 * a fix that never landed is not the loop's last word: it is the same unreviewed
 * head again. So the step that KNOWS whether a fix landed records it here, and
 * `lensPolicyOf` reads this rather than guessing from the dispatch log.
 *
 * The event records the round the findings came from (the one the fix wave
 * answered), not the round number the re-review will carry — the round counter
 * moves when the next review starts, and a record of what was answered must not
 * move with it.
 */
export type LensFixRereviewedEvent = {
  /** #1537 — the re-review for round `round`'s blocking verdict has been run. */
  kind: "lens-fix-rereviewed";
  at: number;
  /** The round whose findings the fix wave answered. */
  round: number;
  /** The head the fix wave landed, when one could be read. The re-review is
   * scoped to `reviewedHead..headSha`; absent means the driver could not read
   * the tip, and the re-review runs unscoped rather than against a guess. */
  headSha?: string;
  /** The head the answered verdict read, i.e. the base of that scope. */
  reviewedHead?: string;
};
