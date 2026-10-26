import { looksLikeCredential } from "./work-driver-verify-assertion.ts";
/**
 * work-driver-verify-base-confirm-prose — the operator's sentences about the two
 * base runs of a #1826 confirmation.
 *
 * The RULE lives in `work-driver-verify-base-confirm.ts`; this module is the half
 * that turns a judged pair into published text. They are separate because they fail
 * differently: the rule is wrong when it confirms what no run established, the prose
 * is wrong when it says more than the record holds. In one file, a change to the
 * table routinely touched the sentences too and neither change was reviewable alone.
 *
 * `confirmingOutcomeProse` is what the `reason` field, the consultation note and the
 * comparison's own note all read, which is what makes "the confirming run was red"
 * about a run that came back green one site's bug rather than three.
 */
import {
  type BaseRedConfirmationResult,
  CONFIRMING_RUN_UNREADABLE,
} from "./work-driver-verify-base-confirm.ts";
import type { BaselineVerdict, RedBaselineVerdict } from "./work-driver-verify-baseline.ts";

/**
 * Text that came from git or the executor and is about to be interpolated into
 * PUBLISHED evidence prose (a finding, a note a handoff renders, a forge comment).
 *
 * `probeBaselineVerify` puts a git error's message straight into an `unknown`
 * verdict's `reason`, and the base seams also interpolate the project's verify
 * command into the same sentences. Both are child output that reaches a GitHub
 * comment, so the credential veto the verify module applies to test output runs
 * BEFORE the interpolation: a token in a `git worktree add` failure or in a command
 * line must not be published because it arrived in a `reason` field rather than in a
 * test's own stdout.
 *
 * The veto is a REFUSAL, not a rewrite: text it rejects is replaced with a fixed
 * placeholder, so the note still says what happened without carrying the secret.
 */
export function publishableEvidenceText(text: string): string {
  return looksLikeCredential(text) ? "[redacted: credential-shaped output]" : text;
}

/**
 * The words a non-confirmed pair is reported with, derived from the arm the
 * confirming run ACTUALLY reached. The record's `reason` and the consultation note
 * both read this, so neither can say "the confirming run was red" about a run that
 * came back green, killed, unreadable, or naming a different test.
 */
export function confirmingOutcomeProse(result: BaseRedConfirmationResult): string {
  if (result.second === undefined) {
    return result.ranSecond
      ? `the confirming run ${CONFIRMING_RUN_UNREADABLE}`
      : "the first run reached no verdict, so there was nothing to confirm";
  }
  switch (result.second.status) {
    case "green":
      return "the confirming run was green";
    case "red-timed-out":
      return "the confirming run was killed at its bound";
    case "unknown":
      return `the confirming run ${CONFIRMING_RUN_UNREADABLE}`;
    case "red":
      // The pair FAILED twice — that is the literal fact, and this function states
      // only what the confirming run reached. The names-disagree half is the
      // caller's to add (see `notConfirmedProse` in the comparison seam), because it
      // is about the PAIR and not about this run, and a record must never claim more
      // than it watched.
      return "the confirming run was red";
  }
}

/** The operator's line for one base run, naming which run it was. */
function runLine(which: string, run: BaselineVerdict): string {
  // A REUSED arm is a colour, not a stream: the record carries the arm
  // (`timedOut`) but no output, so it may be reported as the arm it is and never
  // as a test the probe watched. Rebuilding a plain `red` from a killed record is
  // the #1765 lens-round-1 defect — it tells an operator to go fix a test nobody
  // ran — and it is why this reads the arm before any colour shorthand.
  if (run.status === "red-timed-out") return `${which}: FAILED, killed at its bound`;
  if (run.status === "red") return `${which}: FAILED`;
  if (run.status === "green") return `${which}: PASSED`;
  // The `unknown` arm's `reason` is a git or executor message that reached this
  // module through a verdict, and the sink that renders it is a handoff note or a
  // forge comment — so the credential veto is applied HERE, at the interpolation
  // point, rather than at each of the four call sites that print this line (a
  // caller that forgot one published the secret, with the redaction as one
  // reviewer's bug).
  return `${which}: not established (${publishableEvidenceText(run.reason)})`;
}

/**
 * The names one run's evidence carries, for the operator's line.
 *
 * A REUSED arm is asked for NOTHING: its record has no stream, and the run it
 * describes happened in a tree this seam cannot see. Printing the live second
 * run's names under "base run 1" would attribute a test to a run that named no
 * test — and on a reused arm the whole evidence sentence is the one sentence an
 * operator acts on.
 */
function runNames(
  run: BaselineVerdict | RedBaselineVerdict,
  names: readonly string[] | undefined,
): readonly string[] | undefined {
  if (run.status !== "red" && run.status !== "red-timed-out") return names;
  if (run.reused === true) return undefined;
  return names === undefined || names.length === 0 ? undefined : [...names];
}

/** The names a run carried, bounded so the evidence line stays short. */
function namesSuffix(names: readonly string[] | undefined): string {
  if (names === undefined) return "";
  const shown = names.slice(0, 4).join(", ");
  return ` — named: ${shown}${names.length > 4 ? `, +${names.length - 4} more` : ""}`;
}

/**
 * The prose that names BOTH base runs, appended to a confirmed-red finding.
 * Today's single-arm message says "the gate was red before this change was
 * written"; an operator reading it cannot tell one run from a confirmation, and
 * the whole point of #1826 is that a single run is not what parked the cycle.
 * Absent for a first run that decided alone (timed-out), which never confirms.
 */
export function baseRunsProse(result: BaseRedConfirmationResult): string {
  if (result.second === undefined) return "";
  // Only an anchored comparison may claim the runs AGREED on a name. When nothing
  // could be placed the sentence says so, because the alternative — printing the
  // two runs' names side by side — reads as a comparison this seam never made.
  const common =
    result.commonNames === undefined || result.commonNames.length === 0
      ? result.namesUnplaceable === true
        ? " — the runs' failing-test names could not be placed in either tree, so the claim rests on two red runs rather than on a name match"
        : ""
      : ` — both runs named: ${result.commonNames.slice(0, 4).join(", ")}`;
  return `${runLine("base run 1", result.first)}${namesSuffix(runNames(result.first, result.firstNames))}; ${runLine("base run 2", result.second)}${namesSuffix(runNames(result.second, result.secondNames))}${common}`;
}
