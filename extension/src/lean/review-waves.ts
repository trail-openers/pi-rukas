/**
 * lean/review-waves — the ONE-WAVE policy: what one review step may buy, and
 * the causes it hands back with when the wave does not clear.
 *
 * `review.ts` is the decision procedure; this module is the policy the decision
 * procedure reads, so the numbers and the words that state them have one home
 * that a test can import rather than a string in a loop body. The facts that
 * live here are the child budget (`reviewPasses`, `REVIEW_CHILD_BUDGET`), the
 * named handback causes, the bar a carried row must reach to hand the run back,
 * and the rendering of a row into a handback line.
 *
 * **One full review, one fix wave, one re-review of the fix diff.** There is no
 * round loop, so there is no round constant, no stagnation tie-breaker and no
 * per-round tree naming: the wave is fixed-length and the children it buys are
 * counted by construction. Extra rounds were measured to make things worse, not
 * better — a second review round lowered F1 0.376 → 0.303 with false positives
 * up 62% against true positives up 15%, and forced extra revisions dropped patch
 * correctness from 82% to 67–69% — and every production reviewer surveyed scopes
 * a re-review to the new commits and caps it.
 *
 * **The budget is a budget, not an aspiration.** `REVIEW_CHILD_BUDGET` is the
 * ceiling on the children THIS step dispatches: two adversarial gate passes,
 * twelve lens children, one fixer wave. It counts lean's own children only — the
 * adversarial loop's inner reviewer, the policy judge behind
 * `ReviewDeps.reviewThreshold` and the disclosure post the review layer makes are
 * not this step's dispatches and are not in the count. A step that bought a
 * third review pass, or a second fixer, is over budget, and the bound is asserted
 * against `rows` — the same record the operator reads — rather than a counter
 * only the tests consult.
 */

import { neutraliseEvidence } from "../comment-evidence.ts";
import type { Severity, Verdict } from "../lens-review-format.ts";
import { SEVERITY_RANK, findingDescription } from "../lens-review-format.ts";
import type { Finding } from "../lens-review-types.ts";

/** How many lenses one review pass dispatches — the roster the step buys. */
export const LENSES_PER_PASS = 6;

/**
 * How many review passes one `review` step may dispatch: the full review and the
 * re-review of the fix diff. Never a third.
 *
 * A pass is one adversarial gate call plus one {@link LENSES_PER_PASS}-lens
 * round, which is what `REVIEW_CHILD_BUDGET` spells out in children. The number
 * is a policy statement rather than a knob: a second fix wave and a third pass is
 * the loop this step used to have, and that loop is what the measurements above
 * say to delete.
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
 * them — because which verdict buys a wave is policy, not loop mechanics.
 *
 * **`lensBlocks`** is the bar, and it is ONE bar: `SEVERITY_RANK` against the
 * threshold the step resolved at the base commit. A CRITICAL verdict blocks, and
 * so does any row the round reported at or above the project's own bar — which is
 * what `AGENTS.md §1` means when it says HIGH and above is blocking, and what this
 * issue's one-wave policy means when it says the wave answers blocking findings. A
 * round whose verdict is `ISSUES_FOUND` because one row sat at the bar is a demand
 * for the wave, not a disclosure: `computeVerdict` reaches `ISSUES_FOUND` for
 * findings at or above the threshold, so reading only the verdict would let a HIGH
 * ship disclosed while the step called the round clean.
 * `MINOR_OBSERVATIONS` and an `ISSUES_FOUND` whose rows all sit BELOW the bar buy
 * nothing, and the disclosure path for them already exists: the adversarial pass's
 * findings travel to the lenses as `carried` and the lens round's go to the layer's
 * own residual post. The adversarial role's doctrine is unchanged by this — only
 * `CRITICAL_ISSUES_FOUND` is "Must fix before proceeding" there, and
 * `decideLoopAction` in `adversarial-verdict.ts` still passes on `ISSUES_FOUND` and
 * `MINOR_OBSERVATIONS`: the gate's own verdict buys no wave; the rows do. What a non-blocking verdict reports is not discarded — the adversarial
 * pass's findings travel to the lenses as `carried` and the lens round's go to the
 * layer's own residual post, which is where non-blocking findings have always gone.
 *
 * **`LENS_DID_NOT_RUN`** is the other side of the same enum, and the reason the bar
 * is an allowlist: a round that hit `REVIEW_INCOMPLETE` or a round cap reviewed
 * nothing, so it is neither a pass to walk on nor a verdict to fix against — and it
 * is refused BEFORE the bar is consulted, in both directions, so an incomplete
 * round can never fall through the non-blocking branch into a `done` that
 * certifies a head nobody looked at.
 *
 * Both are typed against the review layer's own `Verdict` union: a `string[]`
 * compared against a widened `verdict: string` lets a renamed verdict silently
 * stop matching, and the round it was meant to classify would then be judged by
 * the wrong rule.
 */
export const LENS_BLOCKING_VERDICTS: readonly Verdict[] = ["CRITICAL_ISSUES_FOUND"];

/**
 * Did this six-lens round block the run? Its own CRITICAL verdict, or a reported
 * row at the project's bar.
 *
 * The row scan reads `reported` and nothing else, because that is the tier the
 * layer itself calls blocking: `splitAdvisory` has already moved the rows whose
 * cited line sits outside the reviewed range out of it, and the layer excludes
 * those from its verdict, its counts and its `hasCritical`. A round whose rows all
 * sit below the threshold therefore does not block even when its verdict is
 * `ISSUES_FOUND` — the verdict is reached from the rows, so a fixture that said
 * otherwise would be asserting a state the layer cannot produce.
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
 * The two handback causes are named here, and only here, because three surfaces
 * print them — this step's throw, `handback`'s cause line, and the headless
 * result's `failure.message` — and a test that matches a phrase nobody owns is
 * how a handback cause silently stops being matchable.
 */
export const CAUSE_NOT_ADDRESSED = "review: blocking finding not addressed";

/** The cause for a CRITICAL the re-review found in the fix range itself. */
export const CAUSE_NEW_CRITICAL = "review: fix introduced a CRITICAL";

/**
 * Does a row reach the bar the step was told to review at?
 *
 * THE ONE PREDICATE both bars read — the wave bar in {@link lensBlocks} and the
 * re-review's carried-row bar in {@link blockingSeverity} — because two rules over
 * the same `SEVERITY_RANK` are two rules that drift apart, and the drift only
 * shows up when a round's verdict and the step's decision disagree about the same
 * row. The bar is the `Severity` `ReviewDeps.reviewThreshold` resolved once at the
 * run's base commit, never a constant here: `AGENTS.md §1` states HIGH and above
 * for this repo, and a project that states a looser bar in its doctrine gets a
 * looser wave AND a looser handback bar, rather than a step that blocks below the
 * threshold it was told to review at.
 *
 * The unknown-severity arm is why this is a function and not a comparison at the
 * call site. A row is parsed model output: one whose `severity` is missing or
 * outside the four schema values is not a row below the bar, and reading it as one
 * would let a malformed row clear the wave. An unrecognised severity therefore
 * counts as blocking — the direction every other absence in this step goes.
 */
export function atOrAboveBar(f: { severity: Finding["severity"] }, threshold: Severity): boolean {
  const rank = SEVERITY_RANK[f.severity];
  return rank === undefined || rank <= SEVERITY_RANK[threshold];
}

/**
 * Is a row of the re-review blocking, by the same bar the wave was bought at?
 *
 * The alias exists so the two call sites say what they are asking ("is this
 * carried row blocking?") while sharing {@link atOrAboveBar}'s one rule.
 */
export function blockingSeverity(
  f: { severity: Finding["severity"] },
  threshold: Severity,
): boolean {
  return atOrAboveBar(f, threshold);
}

/**
 * One row as the operator reads it in the handback: severity, lens, citation and
 * title, on one line, with every field the round's model chose neutralised
 * exactly as the review layer neutralises it before it reaches a post — the title
 * and description, but `path` and `lens` too, which arrive from a lens payload and
 * are no more trusted than the prose beside them. A refusal that carried only a
 * citation could not be triaged without the transcript.
 */
export function renderFinding(f: Finding): string {
  const where = `${neutraliseEvidence(f.path)}:${f.line ?? "?"}`;
  return `[${f.severity}] ${neutraliseEvidence(f.lens)} ${where} — ${neutraliseEvidence(f.title)}: ${neutraliseEvidence(findingDescription(f))}`;
}

/**
 * The rows a refusal quotes, bounded by ROWS rather than by characters.
 *
 * A character clip on the joined string cut the LAST row mid-sentence and kept
 * every row before it, so an operator read three findings in full and a fragment
 * of the one that mattered. `max` whole rows, then a `+K more` tail that states
 * how many were left out: the refusal stays the same order, and nothing is half a
 * finding.
 */
export function renderRows(rows: readonly string[], max = 5): string {
  if (rows.length <= max) return rows.join("; ");
  const head = rows.slice(0, max).join("; ");
  return `${head}; +${String(rows.length - max)} more`;
}
