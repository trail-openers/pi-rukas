/**
 * lens-review-coverage-report — the operator-facing half of the coverage
 * accounting (lens-review-coverage.ts holds the bookkeeping).
 *
 * Two sections, and the split between them is the whole design:
 *
 *   `unreviewedLanesSection`  — the VERDICT. Lanes that came back having
 *         reviewed nothing: no reported finding and none of the closing summary
 *         the lens prompt requires. The round carrying them is REVIEW_INCOMPLETE.
 *   `unaccountedSection`      — the DISCLOSURE. Changed files no evidence names.
 *         Surfaced for the operator, never deciding the round.
 *
 * Each gets its own banner rather than a line appended to the blocked-lens
 * banner in lens-review-render.ts, because three faults send the operator after
 * three different fixes: a lane that FAILED TO COMPLETE (crash, kill, unreadable
 * skill — the blocked banner), a lane that COMPLETED and reviewed nothing (re-run
 * that lane), and a changed file nobody named (read that file before accepting).
 * Telling an operator "the review did not complete" without saying which is how
 * they end up hunting a crash that never happened.
 */

/** The verdict-bearing banner: the lanes that came back having reviewed
 * nothing.
 *
 * Sorted HERE for the same reason as the disclosure list below: a report whose
 * order moves between rounds cannot be diffed or compared, and the one caller
 * that forgot is the one that ships. Empty input contributes nothing, so a
 * round whose every lens left evidence behind reads exactly as it did before
 * this section existed. */
export function unreviewedLanesSection(lanes: readonly string[]): string[] {
  if (lanes.length === 0) return [];
  const named = [...lanes].sort();
  return [
    "",
    `⛔ REVIEW INCOMPLETE — ${named.length} lens(es) came back having reviewed nothing (no finding reported and no closing summary written):`,
    ...named.map((l) => `  - ${l}`),
    "",
    "A lens that reviewed nothing is not a lens that found nothing: the round does not count as a pass. Re-dispatch dispatch_lens_review, or override and proceed despite the unreviewed lanes.",
  ];
}

/** The disclosure lines naming the changed files no evidence accounts for.
 *
 * DISCLOSURE, not a verdict. A lens reads the whole diff through its own lens
 * and owes the prompt a closing summary, not a file inventory, so a path that
 * appears in nobody's prose is a gap worth naming to the operator and not proof
 * that nobody read the file. Measured before this was settled: gating on this
 * list instead refused rounds whose six lenses all completed, redding three of
 * this harness's own lens tests on a one-file diff whose lenses answered in
 * prose. A gate that fails correct work is not a gate. See
 * `unreviewedLanes` in lens-review-coverage.ts for the question that does gate.
 *
 * Sorted HERE for the same reason as above. */
export function unaccountedSection(unaccounted: readonly string[]): string[] {
  if (unaccounted.length === 0) return [];
  const files = [...unaccounted].sort();
  return [
    "",
    `⚠ COVERAGE — the diff changes ${files.length} file(s) no lens accounted for (no finding cited them and no closing summary named them):`,
    ...files.map((f) => `  - ${f}`),
    "",
    "An unjudged file is not a clean file: no lens named it, so read these lanes before accepting the round.",
  ];
}
