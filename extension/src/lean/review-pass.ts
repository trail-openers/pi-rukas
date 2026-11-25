/**
 * lean/review-pass — how a cleared round is reported to the engine.
 *
 * Split from `review.ts` along its own seam: these are the step's *clean* surface: everything about a pass
 * that continues the run, with no gate, no git and no dispatch. The step decides; this says what a decision
 * looks like once made — and the clipping rule below is a contract with the state loader that a reader should
 * meet once, in a file whose subject is it.
 */

import { neutraliseEvidence } from "../comment-evidence.ts";
import type { LensRound } from "./review-args.ts";
import { passKind } from "./review-step.ts";
import { DISPATCHES_MAX_ROWS } from "./state-outcome.ts";
import type { Outcome } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

export { disclosureNote, cleanPass, postFailureNote };

/**
 * The bounded summary a fixed pass owes the operator for what it DISCLOSED.
 *
 * A non-blocking adversarial pass and the re-review's below-the-bar rows have no other consumer here: the
 * frozen driver hands them to the PR body and the residual post, and lean has no PR body. So the count and
 * the gate's words ride the outcome reason — bounded and neutralised, because the reason is a stored surface
 * and the gate's words are a model's reply.
 */
function disclosureNote(disclosedRows: number, gateText: string): string {
  // Neutralised first, then clipped: the text is the adversarial pass's own reply, so it gets the treatment
  // every model-authored field gets before a stored surface, and `neutraliseEvidence`'s clip bounds it — a
  // second `slice` would be a second length rule for the same string.
  const gate = neutraliseEvidence(gateText.trim());
  if (gate === "" && disclosedRows === 0) return "";
  const parts: string[] = [];
  if (disclosedRows > 0)
    parts.push(`${String(disclosedRows)} below-bar ${disclosedRows === 1 ? "row" : "rows"}`);
  if (gate !== "") parts.push(`adversarial (non-blocking): ${gate}`);
  return `; DISCLOSED: ${parts.join("; ")}`;
}

/**
 * What the STEP'S OWN disclosures say when the forge refused one. `cleanPass` carries the lens layer's account
 * of a failed residual post; this is its sibling for comments the review step posts itself. A refused comment
 * never changes the verdict — but a reader who cannot see it is missing a disclosure with nothing saying so.
 */
function postFailureNote(owed: string): string {
  const what = neutraliseEvidence(owed);
  if (what === "") return "";
  return `; DISCLOSURE NOT POSTED: ${what}`;
}

/**
 * The step's pass outcome: kind, reason, and rows — bounded like every other surface that reports rows.
 *
 * `DISPATCHES_MAX_ROWS` is the validator's own cap. An unbounded pass was the one arm that could hand the
 * engine a record the loader rejects — which reports no over-long run: it drops the step's cost rows
 * entirely and silently under-bills the most expensive child.
 *
 * **`fixed` or `done`.** The two kinds differ only in whether the fix wave pushed commits; `passKind`
 * reads that pair (see `fixedFromLog`).
 *
 * The note a cleared round still owes: `finishLensReview` sets it only on an ISSUES_FOUND round whose
 * disclosure post failed, so it cannot arrive on a clean verdict — but a note read by nothing is the silent
 * version of the failure it reports, and the merge guard's round-cap path refuses a merge until it is posted.
 */
function cleanPass(
  round: LensRound & { head: string },
  rows: DispatchUsageRow[],
  fixed: boolean,
  disclosed = "",
): Outcome {
  // The note is the review layer's account of a failed post, and its text embeds model-authored finding prose
  // from the round. It rides the reason the engine stores, so it gets the treatment every model-authored field
  // gets before a stored surface (`neutraliseEvidence`: one line, no fence delimiters, no parsable marker,
  // clipped). `disclosureNote` neutralises the gate's words beside it; a reason that disarmed half its model
  // prose was the half nobody looked at.
  const owed =
    round.note === undefined || round.note.trim() === ""
      ? ""
      : `; DISCLOSURE NOT POSTED: ${neutraliseEvidence(round.note)}`;
  return {
    kind: passKind(fixed),
    reason: `adversarial and six-lens review clean at ${round.head.slice(0, 12)} (${round.verdict}${fixed ? ", one fix wave, re-reviewed" : ", no fixer"})${owed}${disclosed}`,
    dispatches: rows.slice(-DISPATCHES_MAX_ROWS),
  };
}
