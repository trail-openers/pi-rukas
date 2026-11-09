/**
 * lean/review-waves — the ONE-WAVE policy: what one review step may buy, and the causes it hands
 * back with when the wave does not clear.
 *
 * `review.ts` is the decision procedure; this module is the policy it reads, so the numbers and the
 * words stating them have one home a test can import: the child budget, the named handback causes,
 * the one bar a row must reach to block, and the rendering of a row into a handback line.
 *
 * **One full review, one fix wave, one re-review of the fix diff.** There is no round loop, so there
 * is no round constant, no stagnation tie-breaker and no per-round tree naming. Extra rounds make
 * things worse: a second review round lowers F1 with false positives rising faster than true ones,
 * and forced extra revisions drop patch correctness.
 *
 * **The budget is a budget, not an aspiration.** `REVIEW_CHILD_BUDGET` is the ceiling on the children
 * THIS step dispatches, and counts lean's own children only. The bound is asserted against `rows` —
 * the same record the operator reads — rather than a counter only the tests consult.
 */

import { neutraliseEvidence } from "../comment-evidence.ts";
import type { Severity, Verdict } from "../lens-review-format.ts";
import { SEVERITY_RANK, findingDescription } from "../lens-review-format.ts";
import { cappedSuffix } from "../lens-review-render.ts";
import { type Finding, isCarried } from "../lens-review-types.ts";

/** How many lenses one review pass dispatches — the roster the step buys. */
export const LENSES_PER_PASS = 6;

/**
 * How many review passes one `review` step may dispatch: the full review and the re-review of the
 * fix diff. Never a third — a second fix wave would reintroduce the loop this policy excludes.
 */
export const REVIEW_PASSES = 2;

/** The children two passes imply. */
export const REVIEW_CHILD_BUDGET = {
  adversarialPasses: REVIEW_PASSES,
  lensChildren: REVIEW_PASSES * LENSES_PER_PASS,
  fixerWaves: 1,
} as const;

/** The row count of a full review pass: one gate row plus one row per lens child. */
export const PASS_ROWS = 1 + LENSES_PER_PASS;

/**
 * The two gates' verdicts, partitioned the way the reviewing layers partition them — which verdict
 * buys a wave is policy, not loop mechanics.
 *
 * {@link LENS_DID_NOT_RUN} is the other side of the same enum, and the reason the bar is an
 * allowlist: an incomplete round reviewed nothing, so it is refused BEFORE the bar is consulted — it
 * must never fall through the non-blocking branch into a `done` that certifies a head nobody looked
 * at.
 *
 * Typed against the layer's own `Verdict` union: a `string[]` compared against a widened
 * `verdict: string` lets a renamed verdict silently stop matching.
 */
const LENS_BLOCKING_VERDICTS: readonly Verdict[] = ["CRITICAL_ISSUES_FOUND"];

/**
 * Did this six-lens round block the run? Its own CRITICAL verdict, or a reported row at the
 * project's bar. The row scan reads `reported` and nothing else, because that is the tier the layer
 * itself calls blocking — `splitAdvisory` moves the out-of-range rows out of it when it can read
 * the PR's changed lines, and keeps every row in `reported` when it cannot.
 *
 * The asymmetry with the re-review is policy: the wave reads `reported` only; the re-review reads
 * both tiers, so rows `splitAdvisory` moved to advisory are still caught by it — when the move
 * happened at all (see above).
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
 * The six-lens verdicts that report an unfinished round, which is no verdict at all: an incomplete
 * round reviewed nothing, and the round-cap verdicts are another component's budget refusing this
 * run — which no fixer can answer.
 */
export const LENS_DID_NOT_RUN: readonly Verdict[] = [
  "REVIEW_INCOMPLETE",
  "ROUND_CAP_REACHED",
  "REVIEW_INCOMPLETE_STREAK",
];

/** The cause when the fix wave produced no change, so there is nothing to re-review. */
export const CAUSE_NO_CHANGE = "review fix produced no change";

/**
 * The cause prefix for a blocking finding the wave did not answer. The handback causes are named
 * here, and only here, because three surfaces print them — this step's throw, `handback`'s cause
 * line, and the headless result's `failure.message`.
 */
export const CAUSE_NOT_ADDRESSED = "review: blocking finding not addressed";

/** The cause for a CRITICAL the re-review found in the fix range itself. */
export const CAUSE_NEW_CRITICAL = "review: fix introduced a CRITICAL";

/**
 * Does a row reach the bar the step was told to review at? THE ONE PREDICATE both bars read — the
 * wave bar in {@link lensBlocks} and the re-review's carried-row scan in `review-step.ts`
 * (`reviewedPass`) — because two rules over the same `SEVERITY_RANK` drift apart and only show up
 * when a round's verdict and the step's decision disagree about the same row. The bar is the
 * `Severity` `ReviewDeps.reviewThreshold` resolved once at the run's base commit, never a constant
 * here.
 *
 * The unknown-severity arm is why this is a function: a row is parsed model output, and one whose
 * `severity` is missing or outside the four schema values is not a row below the bar, so an
 * unrecognised severity counts as blocking.
 */
export function atOrAboveBar(f: { severity: Finding["severity"] }, threshold: Severity): boolean {
  // An own-property lookup, not a bare subscript: `SEVERITY_RANK["__proto__"]` resolves to a
  // prototype member rather than `undefined`, which would read as a rank clearing the bar.
  const rank = Object.hasOwn(SEVERITY_RANK, f.severity) ? SEVERITY_RANK[f.severity] : undefined;
  return rank === undefined || rank <= SEVERITY_RANK[threshold];
}

/**
 * Some row still open on the round that just judged the pre-fix head is a CRITICAL — the trigger for
 * a full re-review, since `rowFate` retires that class on a full round only.
 */
export function carriedCriticalIn(rows: readonly Finding[]): boolean {
  return rows.some((f) => isCarried(f) && f.severity === "CRITICAL");
}

/**
 * One row as the operator reads it in the handback: severity, lens, citation and title on one line,
 * with every model-chosen field neutralised exactly as the review layer neutralises it before a post
 * — `path` and `lens` arrive from a lens payload and are no more trusted than the prose beside them.
 */
export function renderFinding(f: Finding): string {
  const where = `${neutraliseEvidence(f.path)}:${f.line ?? "?"}`;
  // The cap marker comes from the one renderer the review layer uses for it: a fixer told to fix a
  // HIGH the harness already moved to MEDIUM spends the wave on a row that no longer blocks.
  return `[${f.severity}${cappedSuffix(f)}] ${neutraliseEvidence(f.lens)} ${where} — ${neutraliseEvidence(f.title)}: ${neutraliseEvidence(findingDescription(f))}`;
}

/**
 * The rows a refusal quotes, bounded by ROWS rather than by characters: a character clip cuts the
 * LAST row mid-sentence and keeps every row before it. `max` whole rows, then a `+K more` tail.
 */
export function renderRows(rows: readonly string[], max = 5): string {
  if (rows.length <= max) return rows.join("; ");
  const head = rows.slice(0, max).join("; ");
  return `${head}; +${String(rows.length - max)} more`;
}
