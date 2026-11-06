/**
 * lean/review-step — what the `review` step says about its OWN cost, and the shape of
 * a pass. Split from `review.ts` for the 500-line cap (AGENTS.md §12) along the seam
 * this change created: `review.ts` is the loop (which verdict ends it, what a fixer is
 * told, when the bound says stop); these are about money — what to say when the
 * operator's ceiling stopped a child, how the cleared second pass reads its two review
 * records, and which of the step's two kinds a pass carries. None needs the loop's
 * state, and the loop reads all of them through one import.
 *
 * All leaves: `budgetStopped` throws the error `review-errors.ts` already defines, and
 * importing the handler to throw that error would be a cycle for the sake of one
 * `throw` — the same reason `review-errors.ts` and `review-progress.ts` exist.
 * `REVIEW_STATE` is imported from `review-log.ts` rather than restated: two copies of
 * "which state is this" is two answers to that question.
 */

import { neutraliseEvidence } from "../comment-evidence.ts";
import type { Severity } from "../lens-review-format.ts";
import { isCarried } from "../lens-review-types.ts";
import type { OutcomeKind } from "./machine.ts";
import type { LensRound } from "./review-args.ts";
import { ReviewInfraError } from "./review-errors.ts";
import { REVIEW_STATE } from "./review-log.ts";
import { cleanPass, disclosureNote } from "./review-pass.ts";
import {
  CAUSE_NEW_CRITICAL,
  CAUSE_NOT_ADDRESSED,
  atOrAboveBar,
  renderFinding,
  renderRows,
} from "./review-waves.ts";
import type { Outcome } from "./state.ts";
import type { BudgetFired, DispatchUsageRow } from "./step-budget.ts";
import { budgetSentence } from "./step-budget.ts";

/**
 * The cause for a child the operator's ceiling stopped, with the rows the step
 * paid for attached.
 *
 * The message IS `budgetSentence` — the one renderer of a breach, shared with
 * `handback`'s cause and the headless result's `failure.message` — and nothing
 * else. Every other step reports a breach as a `budget` outcome carrying the
 * typed `limit`/`value`/`used` trio, which is what those two readers build the
 * sentence FROM; `review` has no `budget` kind in the table, so the trio would be
 * fields no reader consults and the sentence is what this step can actually hand
 * back. A message of its own wording is how the three surfaces start disagreeing
 * about which lever fired.
 *
 * What rides on the error rather than in the message is the cost: the rows go to
 * `errorOutcome`, which puts them on the step record, and a handback that cannot
 * say what the stopped children cost understates the run.
 */
export function budgetStopped(fired: BudgetFired, rows: DispatchUsageRow[]): ReviewInfraError {
  return new ReviewInfraError(budgetSentence(REVIEW_STATE, fired), rows);
}

/**
 * The kind of a pass that cleared both gates: `fixed` when a fix round moved the
 * branch, `done` when it did not.
 *
 * The two kinds differ in one fact, and the whole routing difference hangs on
 * it: a fix round's `integrate` PUSHES, so the newest `verify` certifies a head
 * that is no longer the branch tip and `ci` refuses to look at it. The loop's own
 * count answers the question for the attempt that ran the round; `fixedFromLog`
 * answers it of the durable log for the one case the count cannot see — the
 * attempt that resumes after a crash, which remembers nothing and still stands on
 * a moved head.
 *
 * The return type is the registry's own `review` entry, not a written-out pair:
 * `machine.ts` is the authority on which kinds `review` may end with, and a third
 * kind reaching this step would be a route for an unreviewed head to reach `ci` —
 * derived here, that refusal is a compile error rather than a test that has to be
 * run. The registry's entry for `review` is exactly `done | fixed`, so the two
 * arms below stay the whole answer. The exhaustive pair enumeration in
 * `test-lean-machine.ts` remains what proves the ROUTES those two kinds take.
 */
/**
 * The pass that ran the one fix wave and both re-review rounds, once everything came
 * back clean: what the step returns when the wave cleared.
 *
 * The three refusals below are the whole reason this lives beside the loop rather
 * than inside it — each throws the error the operator reads, and each needs only
 * what the re-review and the second adversarial pass already reported. The layer's
 * records are the ONE source of truth for what a fix answered: `rowFate` refuses to
 * resolve an open row whose cited code is unchanged, so a row that reaches `reported`
 * carrying `carried` IS the layer's statement that the fix did not answer it, and the
 * step keeps no fate table of its own (a per-finding table was each rule a HIGH
 * finding away from the layer's own answer). So the step reads three things: the
 * layer's CRITICAL verdict, a carried row at the project's bar or above, and the
 * gate's own CRITICAL record — nothing else ends a wave.
 *
 * The carried scan reads BOTH row sets the layer hands over: `advisory` holds what
 * `splitAdvisory` moved out of `reported`, so a carried HIGH whose cited line fell
 * outside the PR's changed lines is not in `reported` at all, and a check that read only
 * that list would call the wave cleared on a row the layer still holds open — a carried
 * row is the layer saying "not addressed", whatever tier it sits in.
 */
export function reviewedPass(
  reReview: LensRound & { head: string },
  reGate: { findings?: string; open?: boolean; blocking?: boolean },
  opts: { threshold: Severity; preFixHead: string; head: string; rows: DispatchUsageRow[] },
): Outcome {
  const { threshold, preFixHead, head, rows } = opts;
  const reGateText = reGate.findings ?? "";
  const unresolved = [...reReview.reported, ...reReview.advisory].filter(
    (f) => isCarried(f) && atOrAboveBar(f, threshold),
  );
  // The gate's own words join the refusal only when that pass BLOCKED — its CRITICAL
  // record is a demand on the fix, and its wording survives nowhere else (lean has no
  // PR body). A non-blocking pass is disclosure and never renders as a demand.
  const gateRow =
    reGate.blocking === true && reGateText.trim() !== ""
      ? [`[HIGH] ADVERSARIAL ${neutraliseEvidence(reGateText).slice(0, 300)}`]
      : [];
  const where = `Origin is at the fixer's head: the fix IS pushed. Fix range ${preFixHead.slice(0, 12)}..${head.slice(0, 12)}.`;
  if (unresolved.length > 0 || gateRow.length > 0)
    throw new ReviewInfraError(
      `${CAUSE_NOT_ADDRESSED}: ${renderRows([...unresolved.map(renderFinding), ...gateRow])} — the fix wave ran, the re-review carried these blocking rows against the fixed head, and a second wave is not what a gate that repeated itself needs. ${where}`,
      rows,
    );
  if (reReview.verdict === "CRITICAL_ISSUES_FOUND")
    throw new ReviewInfraError(
      `${CAUSE_NEW_CRITICAL}: the re-review of the fix range refused the fixed head (${reReview.verdict}) — ${renderRows(reReview.reported.map(renderFinding))}. ${where}`,
      rows,
    );
  // A CRITICAL the report-only adversarial pass found in the fix range that the lenses
  // did not name is still a CRITICAL the fix introduced, read off the pass's own
  // trailing record by `blockingRecord`. Only a new CRITICAL blocks; a non-blocking
  // pass (MINOR_OBSERVATIONS, ISSUES_FOUND, or the findings it carried onward) is
  // disclosed by the caller and never ends the wave.
  if (reGateText !== "" && reGate.blocking === true)
    throw new ReviewInfraError(
      `${CAUSE_NEW_CRITICAL}: the adversarial pass on the fix range reported a CRITICAL — ${reGateText.slice(0, 500)}. ${where}`,
      rows,
    );
  // Nothing carried and no CRITICAL anywhere: the wave cleared. What the re-review
  // disclosed, and any non-blocking word from the gate, is stated in the reason the
  // operator reads as well as by the layer's own residual post — a non-blocking gate pass
  // has no other consumer here (lean has no PR body, see `openFromPass`), so its count
  // and text go on the outcome rather than being dropped, both neutralised and bounded
  // by `disclosureNote`. The count is the rows this step can say were DISCLOSED, which
  // is not `reported.length`: a carried row below the bar does reach here (the arm above
  // only refuses at the blocking bar), and the rows `splitAdvisory` moved out are the
  // layer's to account for in its own post.
  return cleanPass(
    reReview,
    rows,
    true,
    disclosureNote(
      reReview.reported.filter((f) => !isCarried(f) && !atOrAboveBar(f, threshold)).length,
      reGate.open === true ? reGateText : "",
    ),
  );
}

export function passKind(fixed: boolean): OutcomeKind<"review"> {
  return fixed ? "fixed" : "done";
}
