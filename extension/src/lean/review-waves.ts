/**
 * lean/review-waves — the ONE-WAVE policy: what one review step may buy, and
 * the causes it hands back with when the wave does not clear.
 *
 * `review.ts` is the decision procedure; this module is the policy it reads, so
 * the numbers and the words stating them have one home a test can import rather
 * than a string in a loop body: the child budget, the named handback causes, the
 * one bar a row must reach to block, and the rendering of a row into a handback
 * line.
 *
 * **One full review, one fix wave, one re-review of the fix diff.** There is no
 * round loop, so there is no round constant, no stagnation tie-breaker and no
 * per-round tree naming. Extra rounds make things worse, not better: a second
 * review round lowered F1 with false positives rising faster than true ones, and
 * forced extra revisions dropped patch correctness — and every production reviewer
 * surveyed scopes a re-review to the new commits and caps it.
 *
 * **The budget is a budget, not an aspiration.** `REVIEW_CHILD_BUDGET` is the
 * ceiling on the children THIS step dispatches, and counts lean's own children
 * only — the adversarial loop's inner reviewer, the policy judge behind
 * `ReviewDeps.reviewThreshold` and the layer's disclosure post are not this step's
 * dispatches. The bound is asserted against `rows` — the same record the operator
 * reads — rather than a counter only the tests consult.
 */

import { neutraliseEvidence } from "../comment-evidence.ts";
import type { Severity, Verdict } from "../lens-review-format.ts";
import { SEVERITY_RANK, findingDescription } from "../lens-review-format.ts";
import { cappedSuffix } from "../lens-review-render.ts";
import type { Finding } from "../lens-review-types.ts";

/** How many lenses one review pass dispatches — the roster the step buys. */
export const LENSES_PER_PASS = 6;

/**
 * How many review passes one `review` step may dispatch: the full review and the
 * re-review of the fix diff. Never a third.
 *
 * A pass is one adversarial gate call plus one {@link LENSES_PER_PASS}-lens round.
 * A policy statement rather than a knob: a second fix wave and a third pass is the
 * loop this policy exists to delete.
 */
export const REVIEW_PASSES = 2;

/** The child ceiling that follows from {@link REVIEW_PASSES} and {@link LENSES_PER_PASS}. */
export const REVIEW_CHILD_BUDGET = {
  adversarialPasses: REVIEW_PASSES,
  lensChildren: REVIEW_PASSES * LENSES_PER_PASS,
  fixerWaves: 1,
} as const;

/** The row count of a full review pass: one gate row plus one row per lens child. */
export const PASS_ROWS = 1 + LENSES_PER_PASS;

/**
 * The two gates' verdicts, partitioned the way the reviewing layers partition
 * them — which verdict buys a wave is policy, not loop mechanics.
 *
 * `lensBlocks` is the bar, and it is ONE bar. A round whose verdict is
 * `ISSUES_FOUND` because one row sat at the bar is a demand for the wave, not a
 * disclosure: `computeVerdict` reaches `ISSUES_FOUND` from rows at or above the
 * threshold, so reading only the verdict would let a HIGH ship disclosed while the
 * step called the round clean. `MINOR_OBSERVATIONS` and an `ISSUES_FOUND` whose rows
 * all sit BELOW the bar buy nothing, and their disclosure path already exists: the
 * adversarial pass's findings travel to the lenses as `carried`, the lens round's to
 * the layer's own residual post. The gate's own verdict buys no wave; the rows do.
 *
 * {@link LENS_DID_NOT_RUN} is the other side of the same enum, and the reason the
 * bar is an allowlist: an incomplete round reviewed nothing, so it is neither a pass
 * to walk on nor a verdict to fix against, and it is refused BEFORE the bar is
 * consulted — an incomplete round must never fall through the non-blocking branch
 * into a `done` that certifies a head nobody looked at.
 *
 * Typed against the layer's own `Verdict` union: a `string[]` compared against a
 * widened `verdict: string` lets a renamed verdict silently stop matching.
 */
export const LENS_BLOCKING_VERDICTS: readonly Verdict[] = ["CRITICAL_ISSUES_FOUND"];

/**
 * Did this six-lens round block the run? Its own CRITICAL verdict, or a reported
 * row at the project's bar.
 *
 * The row scan reads `reported` and nothing else, because that is the tier the
 * layer itself calls blocking: `splitAdvisory` already moved the rows whose cited
 * line sits outside the reviewed range out of it, and the layer excludes those from
 * its verdict, its counts and its `hasCritical`.
 *
 * The asymmetry with the re-review is policy: the wave reads `reported` only, but
 * a CARRIED advisory row is still caught by the re-review's NOT ADDRESSED scan,
 * which reads both tiers.
 */
export function lensBlocks(
  round: { verdict: Verdict; reported: readonly Finding[] },
  threshold: Severity,
): boolean {
  return (
    LENS_BLOCKING_VERDICTS.includes(round.verdict) ||
    round.reported.some((f) => atOrAboveBar(f, threshold))
  );
}

/**
 * The six-lens verdicts that report an unfinished round, which is no verdict at
 * all: an incomplete round reviewed nothing, so it is not a pass to walk on and
 * not evidence to fix against, and the round-cap verdicts are another component's
 * budget refusing this run — which no fixer can answer, since only the operator
 * named and may lift that budget.
 */
export const LENS_DID_NOT_RUN: readonly Verdict[] = [
  "REVIEW_INCOMPLETE",
  "ROUND_CAP_REACHED",
  "REVIEW_INCOMPLETE_STREAK",
];

/** The cause when the fix wave produced no change, so there is nothing to re-review. */
export const CAUSE_NO_CHANGE = "review fix produced no change";

/**
 * The cause prefix for a blocking finding the wave did not answer.
 *
 * The handback causes are named here, and only here, because three surfaces print
 * them — this step's throw, `handback`'s cause line, and the headless result's
 * `failure.message` — and a test that matches a phrase nobody owns is how a cause
 * silently stops being matchable.
 */
export const CAUSE_NOT_ADDRESSED = "review: blocking finding not addressed";

/** The cause for a CRITICAL the re-review found in the fix range itself. */
export const CAUSE_NEW_CRITICAL = "review: fix introduced a CRITICAL";

/**
 * Does a row reach the bar the step was told to review at?
 *
 * THE ONE PREDICATE both bars read — the wave bar in {@link lensBlocks} and the
 * re-review's carried-row scan in `review.ts` — because two rules over the same
 * `SEVERITY_RANK` drift apart and only show up when a round's verdict and the
 * step's decision disagree about the same row. The bar is the `Severity` that
 * `ReviewDeps.reviewThreshold` resolved once at the run's base commit, never a
 * constant here: a project that states a looser bar gets a looser wave AND a
 * looser handback bar.
 *
 * The unknown-severity arm is why this is a function and not a comparison at the
 * call site. A row is parsed model output: one whose `severity` is missing or
 * outside the four schema values is not a row below the bar, so an unrecognised
 * severity counts as blocking — the direction every other absence here goes.
 */
export function atOrAboveBar(f: { severity: Finding["severity"] }, threshold: Severity): boolean {
  // An own-property lookup, not a bare subscript: a row is parsed model output, and
  // `SEVERITY_RANK["__proto__"]`/`["constructor"]` resolve to prototype members
  // rather than `undefined`, which read as a rank would clear the bar.
  const rank = Object.hasOwn(SEVERITY_RANK, f.severity) ? SEVERITY_RANK[f.severity] : undefined;
  return rank === undefined || rank <= SEVERITY_RANK[threshold];
}

/**
 * One row as the operator reads it in the handback: severity, lens, citation and
 * title on one line, with every model-chosen field neutralised exactly as the
 * review layer neutralises it before a post — `path` and `lens` arrive from a lens
 * payload and are no more trusted than the prose beside them. A refusal that
 * carried only a citation could not be triaged without the transcript.
 */
export function renderFinding(f: Finding): string {
  const where = `${neutraliseEvidence(f.path)}:${f.line ?? "?"}`;
  // The cap marker comes from the one renderer the review layer uses for it: a
  // fixer told to fix a HIGH the harness already moved to MEDIUM spends the wave on
  // a row that no longer blocks.
  return `[${f.severity}${cappedSuffix(f)}] ${neutraliseEvidence(f.lens)} ${where} — ${neutraliseEvidence(f.title)}: ${neutraliseEvidence(findingDescription(f))}`;
}

/**
 * The rows a refusal quotes, bounded by ROWS rather than by characters: a
 * character clip cuts the LAST row mid-sentence and keeps every row before it, so
 * an operator reads three findings in full and a fragment of the one that mattered.
 * `max` whole rows, then a `+K more` tail stating how many were left out.
 */
export function renderRows(rows: readonly string[], max = 5): string {
  if (rows.length <= max) return rows.join("; ");
  const head = rows.slice(0, max).join("; ");
  return `${head}; +${String(rows.length - max)} more`;
}
