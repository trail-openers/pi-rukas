/**
 * lean/review-pass — how a cleared round is reported to the engine.
 *
 * Split from `review.ts`, which passed the size cap once the wave's verification
 * lived beside its decision. These two are the step's *clean* surface: everything
 * about a pass that continues the run, with no gate, no git and no dispatch in it.
 * The step decides; this says what a decision looks like once made. It lives apart
 * for the same reason the round guards do — a rule that can only be reasoned about
 * inside the step gets reasoned about wrongly — and because the clipping rule below
 * is a contract with the state loader that a reader should meet once, in a file whose
 * whole subject is that contract.
 */

import { neutraliseEvidence } from "../comment-evidence.ts";
import type { LensRound } from "./review-args.ts";
import { passKind } from "./review-step.ts";
import { DISPATCHES_MAX_ROWS } from "./state-outcome.ts";
import type { Outcome } from "./state.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

export { disclosureNote, cleanPass };

/**
 * The bounded summary a fixed pass owes the operator for what it DISCLOSED.
 *
 * A non-blocking adversarial pass and the re-review's below-the-bar rows have no
 * other consumer in this step: the frozen driver hands them to the PR body and the
 * lens round's residual post, and lean has no PR body. So the count and the gate's
 * own words ride on the outcome reason — bounded and neutralised, because the
 * reason is a surface the engine stores and the operator reads, not a transcript,
 * and the gate's words are a model's reply. `""` means nothing was disclosed, and
 * then this contributes nothing to the reason at all.
 */
function disclosureNote(disclosedRows: number, gateText: string): string {
  // Neutralised first, then clipped: the text is the adversarial pass's own reply,
  // so it gets the same treatment every other model-authored field gets before it
  // reaches a stored surface (no fence delimiters, no parsable marker token), and
  // `neutraliseEvidence`'s own clip is what bounds it — a second `slice` here would
  // be a second length rule for the same string.
  const gate = neutraliseEvidence(gateText.trim());
  if (gate === "" && disclosedRows === 0) return "";
  const parts: string[] = [];
  if (disclosedRows > 0)
    parts.push(`${String(disclosedRows)} below-bar ${disclosedRows === 1 ? "row" : "rows"}`);
  if (gate !== "") parts.push(`adversarial (non-blocking): ${gate}`);
  return `; DISCLOSED: ${parts.join("; ")}`;
}

/**
 * The step's pass outcome: the kind, the reason, and the rows — bounded like
 * every other surface that reports rows.
 *
 * `DISPATCHES_MAX_ROWS` is the validator's own cap — `specify` clips its merged
 * rows with it, `errorOutcome.ts` clips the throw path, and an unbounded pass was
 * the one arm that could hand the engine a record the loader then rejects, which
 * does not report an over-long run: it drops the step's cost rows entirely,
 * silently under-billing the child that costs the most.
 *
 * **`fixed` or `done`.** The one fact the two kinds differ in is whether the fix
 * wave pushed commits; `passKind` reads that pair and says why the answer cannot
 * come from a variable alone (see `fixedFromLog`).
 *
 * The note a cleared round still owes: `finishLensReview` sets it ONLY on an
 * ISSUES_FOUND round whose disclosure post failed or could not be attempted, so
 * it cannot arrive on a clean verdict — but "cannot happen" is not a reason to
 * drop it, and a note carried into the step and read by nothing is the silent
 * version of the failure it reports. The merge guard's round-cap path refuses a
 * merge until the marker carrying these findings is on the PR
 * (`merge-guard-round-cap.ts`), so a note this step swallowed would cost the run
 * its ability to continue with nobody able to say why.
 */
function cleanPass(
  round: LensRound & { head: string },
  rows: DispatchUsageRow[],
  fixed: boolean,
  disclosed = "",
): Outcome {
  const owed =
    round.note === undefined || round.note.trim() === ""
      ? ""
      : `; DISCLOSURE NOT POSTED: ${round.note}`;
  return {
    kind: passKind(fixed),
    reason: `adversarial and six-lens review clean at ${round.head.slice(0, 12)} (${round.verdict}${fixed ? ", one fix wave, re-reviewed" : ", no fixer"})${owed}${disclosed}`,
    dispatches: rows.slice(-DISPATCHES_MAX_ROWS),
  };
}
