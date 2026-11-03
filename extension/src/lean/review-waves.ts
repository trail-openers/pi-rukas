/**
 * lean/review-waves — the ONE-WAVE policy: what one review step may buy, and
 * the causes it hands back with when the wave does not clear.
 *
 * `review.ts` is the decision procedure; this module is the policy the decision
 * procedure reads, so the numbers and the words that state them have one home
 * that a test can import rather than a string in a loop body. Three facts live
 * here: the child budget (`reviewPasses`, `REVIEW_CHILD_BUDGET`), the named
 * handback causes, and the one function that turns a delta round's rows into
 * per-finding fates.
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

import { VERDICT_STATUSES } from "../adversarial-verdict.ts";
import { neutraliseEvidence } from "../comment-evidence.ts";
import type { Verdict } from "../lens-review-format.ts";
import { findingDescription } from "../lens-review-format.ts";
import { isCarried } from "../lens-review-types.ts";
import type { Finding } from "../lens-review-types.ts";
import type { FindingOutcome } from "./review-args.ts";

/**
 * How many review passes one `review` step may dispatch: the full review and the
 * re-review of the fix diff. Never a third.
 *
 * A pass is one adversarial gate call plus one six-lens round, which is what
 * `REVIEW_CHILD_BUDGET` spells out in children. The number is a policy statement
 * rather than a knob: a second fix wave and a third pass is the loop this step
 * used to have, and that loop is what the measurements above say to delete.
 */
export const REVIEW_PASSES = 2;

/** The child ceiling that follows from {@link REVIEW_PASSES}. */
export const REVIEW_CHILD_BUDGET = {
  adversarialPasses: 2,
  lensChildren: 12,
  fixerWaves: 1,
} as const;

/** The row count of a full review pass: one gate row plus one row per lens child. */
export const PASS_ROWS = 1 + REVIEW_CHILD_BUDGET.lensChildren / REVIEW_PASSES;

/**
 * The two gates' verdicts, partitioned the way the reviewing layers partition
 * them — because which verdict buys a wave is policy, not loop mechanics.
 *
 * **`lensBlocks`** is the bar. The lens layer's `computeVerdict` reserves
 * `CRITICAL_ISSUES_FOUND` for "this must not proceed" and reaches `ISSUES_FOUND`
 * for anything merely at or above the project's bar, and the adversarial role's
 * doctrine calls only `CRITICAL_ISSUES_FOUND` "Must fix before proceeding"
 * (`agents-base/adversarial-developer.md`; `decideLoopAction` in
 * `adversarial-verdict.ts` passes on `ISSUES_FOUND` and `MINOR_OBSERVATIONS`).
 * The step mirrors that split rather than inventing its own: a step that paid a
 * fixer for findings the reviewing layer itself declined to block on bought a
 * child, a re-review and a second gate pass to answer a verdict that did not ask
 * for one. What a non-blocking verdict reports is not discarded — the adversarial
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

/** Did this six-lens round block the run? The layer's own CRITICAL verdict. */
export function lensBlocks(round: { verdict: Verdict }): boolean {
  return LENS_BLOCKING_VERDICTS.includes(round.verdict);
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
 * The identity a blocking finding is matched by, between the full review and the
 * re-review.
 *
 * Location and title, not the rendered line: the re-review's rendering is a
 * different model's wording of the same problem, while a cited `path:line` and a
 * title are what the findings store itself matches rows on. File-level rows
 * (no usable line) key on the path alone, which is the coarsest identity that is
 * still a citation rather than an essay.
 */
export function findingKey(f: Finding): string {
  const line = typeof f.line === "number" && f.line > 0 ? String(f.line) : "?";
  return `${f.path}:${line} ${f.title}`;
}

/** The blocking rows of a round that a fix wave has not yet answered, keyed. */
export type OpenFindings = ReadonlyMap<string, Finding>;

/**
 * The rows of a round the fix wave is being asked to answer, keyed by
 * {@link findingKey}.
 *
 * Every row the round REPORTED, carried ones included. A carried row is the
 * review layer's own "this is still open" — it reached `reported` because
 * `rowFate` refused to resolve it — so it is exactly as much a demand on the fix
 * as a fresh row is, and dropping it here would mean a finding the branch has
 * been carrying across rounds could never be reported NOT ADDRESSED: the step
 * would fix around it and pass.
 */
export function openFindings(round: { reported: Finding[] }): OpenFindings {
  const open = new Map<string, Finding>();
  for (const f of round.reported) open.set(findingKey(f), f);
  return open;
}

/**
 * One row as the operator reads it in the handback: severity, lens, citation and
 * title, on one line, with the row's own evidence neutralised exactly as the
 * review layer neutralises it before it reaches a post. A refusal that carried
 * only `findingKey` output could not be triaged without the transcript.
 */
export function renderFinding(f: Finding): string {
  return `[${f.severity}] ${f.lens} ${f.path}:${f.line ?? "?"} — ${neutraliseEvidence(f.title)}: ${neutraliseEvidence(findingDescription(f))}`;
}

/**
 * What the re-review of the fix diff decided about every finding in play.
 *
 * Three fates, two of them read straight off the review layer's own per-row
 * record rather than a reply protocol this step invented:
 *
 * - **`carried` (NOT ADDRESSED)** — a row the delta round re-reported as carried:
 *   the layer's rule (`rowFate`) refuses to resolve an open row whose cited code
 *   is unchanged, so a carried row IS the statement that the fix did not answer
 *   it. It is blocking only when the layer kept it in `reported`; an out-of-range
 *   carry stays disclosable, exactly as it would in any other round.
 * - **`addressed`** — a first-round row the delta round did NOT carry and did not
 *   re-report. A delta round's range is the fix, so a blocking row that appears
 *   nowhere in it had its cited lines rewritten by the fix: that is the layer's
 *   resolve, and this step does not second-guess it.
 * - **`new-critical`** — a CRITICAL the delta round raised that was not in the
 *   open set before the fix. Scope is the fix range because that is the range
 *   the round reviewed: a CRITICAL outside it cannot be attributed to the fix, and
 *   a CRITICAL the layer moved to the advisory tier never reached `reported` and
 *   does not block here either — the same bar as every other round.
 *
 * The findings no fate covers — new rows below CRITICAL, and carried rows the
 * layer discounted to advisory — are the disclosure set: the review layer posts
 * them through its own residual post, and never start another wave.
 */
export function classifyFates(
  blockingBefore: OpenFindings,
  reReview: { reported: Finding[]; gateFindings?: string; verdict: string },
): FindingOutcome[] {
  const outcomes: FindingOutcome[] = [];
  const seen = new Set<string>();
  // The gate's own words, when the step has them. A finding the adversarial gate
  // raised arrives as the reviewer's prose, not as a row: it is handed to the
  // fixer and it has to appear in the handback, or the operator is told the wave
  // stopped on a finding whose wording only ever existed in the transcript.
  const gateText = (reReview.gateFindings ?? "").trim();
  // A verdict the review layer calls incomplete is refused upstream
  // (`NO_FIX_VERDICTS` in `review.ts`) and must never be rendered as a finding, so
  // only a judgement in the layer's own verdict enum gets a row here. A `REJECTED`
  // or `ERROR` string never enters that enum, so it is not shown either: there is
  // nothing triageable in it, and `assertRan`/the gate have already refused it.
  if (gateText !== "" && (VERDICT_STATUSES as readonly string[]).includes(reReview.verdict))
    outcomes.push({
      id: "adversarial-gate",
      severity: "HIGH",
      line: `[HIGH] ADVERSARIAL ${gateText.slice(0, 300)}`,
      fate: "carried",
      open: true,
    });
  for (const f of reReview.reported) {
    const key = findingKey(f);
    seen.add(key);
    const wasOpen = blockingBefore.has(key);
    // A row the round re-reports is open on the round's own evidence, whatever
    // its severity: a HIGH the lenses still see after its cited line was rewritten
    // is not answered, and the bar for that is the same as the bar that made it
    // blocking in the first place (it is in `reported`, so the layer's threshold
    // already judged it). A carried row is blocking only when it is one this wave
    // was asked about; a carry of something older is the layer's disclosure, and a
    // row that was never open is NEW to the fix range — where only a CRITICAL is
    // attributed to the fix.
    const fresh = !isCarried(f);
    const blocking = fresh || wasOpen;
    outcomes.push({
      id: key,
      severity: f.severity,
      // The rendered line is what makes a refusal triageable: the step's own text
      // carries these, and an id alone names a coordinate the operator cannot read
      // without the transcript. The row's own fields, rendered by this module, are
      // that line.
      line: renderFinding(f),
      fate: blocking ? (isCarried(f) ? "carried" : "new-critical") : "addressed",
      open: blocking,
    });
  }
  for (const [key, f] of blockingBefore) {
    if (seen.has(key)) continue;
    // Not re-reported, not carried: the delta round reviewed the fix and no
    // longer stands by the row. `rowFate` resolves on a changed cited line, and
    // the fix range is all this round covered.
    outcomes.push({
      id: key,
      severity: f.severity,
      line: renderFinding(f),
      fate: "addressed",
      open: false,
    });
  }
  return outcomes;
}
