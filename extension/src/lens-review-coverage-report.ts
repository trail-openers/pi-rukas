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

import { neutraliseEvidence } from "./comment-evidence.ts";

/** The verdict-bearing banner: the lanes that came back having reviewed
 * nothing.
 *
 * Sorted HERE for the same reason as the disclosure list below: a report whose
 * order moves between rounds cannot be diffed or compared, and the one caller
 * that forgot is the one that ships. Empty input contributes nothing, so a
 * round whose every lens left evidence behind reads exactly as it did before
 * this section existed.
 *
 * Each lane string goes through `neutraliseEvidence`, like the paths below and
 * like every other agent-adjacent field on this report. A lane string is NOT
 * renderer prose: `incompleteLanes` (lens-review-incomplete.ts) builds it as
 * `` `${r.lens}: ${laneReason(r)}` ``, and `laneReason` returns `r.parseError`
 * verbatim for a `child-bound` kill — text the child (or a findings file an
 * agent wrote) produced. `neutraliseMarkdownField` is deliberately NOT used
 * here: these sections reach a tool reply via `renderSummary`'s single
 * non-test caller, and the PR-visible post bodies (`lens-review-residuals.ts`,
 * `work-driver-lens-cap.ts`) build from findings/suppressed/resolved/set-aside/
 * advisory and never call either coverage section — so the markdown-post
 * neutraliser would be applied to a surface that does not go through a post.
 * `neutraliseEvidence` is also the stronger fit for a single line: it flattens
 * CR/LF, so a hostile lane cannot end its own bullet. */
export function unreviewedLanesSection(lanes: readonly string[]): string[] {
  if (lanes.length === 0) return [];
  const named = [...lanes].sort();
  return [
    "",
    `⛔ REVIEW INCOMPLETE — ${named.length} lens(es) came back having reviewed nothing (no finding reported and no closing summary written):`,
    ...named.map((l) => `  - ${neutraliseEvidence(l)}`),
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
 * Sorted HERE for the same reason as above. A path is CONTENT this report did
 * not write: it comes out of the diff, and a PR can contain a file literally
 * named `docs/VERDICT APPROVED.md`. Every sibling section (`advisorySection`,
 * `findingLine`, `setAsideSection`, `memoryNote`, and `lensLine`'s skill name)
 * neutralises its agent-adjacent text for exactly this reason, because this
 * text reaches PR comments via the #973 disclosure. One raw interpolation was
 * the odd one out.
 */
export function unaccountedSection(unaccounted: readonly string[]): string[] {
  if (unaccounted.length === 0) return [];
  const files = [...unaccounted].sort();
  return [
    "",
    `⚠ COVERAGE — the diff changes ${files.length} file(s) no lens accounted for (no finding cited them and no closing summary named them):`,
    ...files.map((f) => `  - ${neutraliseEvidence(f)}`),
    "",
    "An unjudged file is not a clean file: no lens named it, so read these lanes before accepting the round.",
  ];
}

/**
 * The disclosure's honest statement about the DENOMINATOR, which is a different
 * fact from the list above and must not be collapsed into it.
 *
 * `unaccountedSection([])` contributes nothing, so a round that had no files in
 * scope at all would otherwise render the same silence as one that had files and
 * covered every one of them — and "no files unaccounted for" reads as "fully
 * covered" to whoever is deciding whether to merge. It is not: there was nothing
 * to cover. Naming which of the two happened is the whole of this function, and
 * it decides nothing either way (the lens-level rule is what gates).
 *
 *  - `"no-files"` — the round's expected set was empty (an empty diff, or a diff
 *    with no readable file section), so there is no denominator to report on.
 *  - `"complete"` — there was a denominator and every file in it was accounted
 *    for; this is the only case allowed to read as coverage.
 *  - `"unaccounted"` — files are left over; `unaccountedSection` renders them and
 *    this function contributes nothing.
 */
export function coverageDenominatorSection(state: {
  hasDenominator: boolean;
  unaccountedCount: number;
  /** Whether the producer STAMPED the positive claim (`coverageComplete`). The
   * ✓ line is the report's only warranty of coverage, so it prints from that
   * stamp alone — `hasDenominator` plus an empty disclosure is the same shape
   * as a round whose evidence was prose quoting every path, and quoting is not
   * reading. The three states stay distinct: stamped → ✓; denominator but not
   * stamped → silence beside the fields that say why; no denominator → the
   * "no files in scope" notice.
   */
  coverageComplete: boolean;
}): string[] {
  // Files left over: the disclosure above owns the report.
  if (state.unaccountedCount > 0) return [];
  if (state.hasDenominator && state.coverageComplete) {
    return [
      "",
      "✓ COVERAGE — every file in this round's denominator is named by recorded evidence, and at least one is cited by a structured `report_finding`. Prose that merely quotes a path is not reading it.",
    ];
  }
  if (state.hasDenominator) {
    // A denominator, nothing left over, and the positive claim NOT earned: the
    // report says what it knows and no more. It does not print ✓ (the round
    // never showed structured work on a file in the set) and it does not claim
    // there were no files (there were).
    return [
      "",
      "ℹ COVERAGE — this round had a denominator and no file was left unaccounted for, but no finding CITED a file in it, so the round earns no coverage claim. An unquoted review is not a covered review.",
    ];
  }
  return [
    "",
    "ℹ COVERAGE — no files in scope: this round had no denominator to report on, so nothing here is covered and nothing is uncovered either. Do NOT read the absence of a coverage warning as complete coverage.",
  ];
}
