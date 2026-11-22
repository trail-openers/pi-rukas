/**
 * lean/engine-facts — the readings of a run's step log the runner consults but
 * does not itself perform: `reasonFor` words why a run ended, and the merge gate
 * (`landEarned`, its refusal wording, and the stamp check that re-asks the gate).
 * All are pure reads of the record, sharing `newestDecided` and the report-state
 * exclusion, which is why they live together.
 */

import { REPORT_FAILED_KIND, exitCodeFor } from "./machine.ts";
import { leanProjectRosterEnabled } from "./project-roster-switch.ts";
import { unacceptedTestEdits, unacceptedTestEditsRefusal } from "./review-test-accept.ts";
import { type LeanRun, type LeanState, type Outcome, isTerminal, newestDecided } from "./state.ts";
import { ROSTER_LAND_REFUSAL } from "./verify-roster.ts";

/** The rules the most recent verdict recorded, for a report that could not deliver them. */
function lastFailedRules(steps: readonly { outcome?: Outcome }[]): unknown[] | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const rules = steps[i]?.outcome?.failedRules;
    if (Array.isArray(rules) && rules.length > 0) return rules as unknown[];
  }
  return undefined;
}

/** Why a run ended where it did — for the result record and the summary line. */
export function reasonFor(
  state: LeanState,
  outcome: Outcome | undefined,
  steps: readonly { outcome?: Outcome }[] = [],
): string {
  if (state === "landed") return "merged";
  const rules = outcome?.failedRules;
  if (Array.isArray(rules) && rules.length > 0) return (rules as unknown[]).join("; ");
  // A refusal reaches here as the outcome of its REPORTING step, which carries the rules it
  // posted (or failed to post). One fact, two readers: the rules alone for a comment that went
  // out, and the rules plus the delivery failure for one that did not.
  if (state === "not-ready") {
    const judged = lastFailedRules(steps);
    if (Array.isArray(judged) && judged.length > 0) {
      const joined = (judged as unknown[]).join("; ");
      const failure =
        outcome?.kind === REPORT_FAILED_KIND
          ? String(outcome.reason ?? outcome.message ?? "report did not land")
          : undefined;
      return failure === undefined ? joined : `${joined}: ${failure}`;
    }
  }
  if (outcome && typeof outcome.reason === "string") return outcome.reason;
  if (outcome && typeof outcome.message === "string") return outcome.message;
  return `ended at ${state}`;
}

/**
 * Has this run earned the merge? Its own record must currently say so: the newest DECIDED
 * `verify` AND the newest DECIDED `ci` both green, and no `draft` marker left standing.
 *
 * Behind the roster switch the green `verify` is read as a RECORD, not only as a kind: the merge is
 * the irreversible act, so it fails closed on a log whose green carries no roster — including a
 * hand-built or resumed one that never ran the project's suite. What the record must additionally
 * name is an edited test whose failing base version the newest review did not accept on the verified
 * head (`review-test-accept.ts`): the step records such a file rather than going red, so the merge is
 * the gate that holds it.
 */
function landEarned(run: LeanRun): boolean {
  if (run.counters.draft) return false;
  if (
    newestDecided(run.steps, "verify")?.outcome?.kind !== "green" ||
    newestDecided(run.steps, "ci")?.outcome?.kind !== "green"
  )
    return false;
  // The off arm asks ONLY the kinds it asked before this field existed, byte for byte.
  if (!leanProjectRosterEnabled()) return true;
  return (
    rosterEarnsLand(newestDecided(run.steps, "verify")?.outcome) &&
    unacceptedTestEdits(run.steps).length === 0
  );
}

/**
 * Does a green verify's record carry a roster the merge may rest on? A missing roster and an empty
 * one are each refused, and so is a green that records BOTH an edited file whose base version passed
 * and any failing test: it vouches for an edited contract while its own head run failed. Refusing the
 * mere FACT of an edit would refuse every legitimate test edit and leave an honest run no path to
 * `landed`.
 */
function rosterEarnsLand(outcome: Outcome | undefined): boolean {
  const roster = outcome?.projectRoster;
  if (roster === undefined) return false;
  if (!Number.isSafeInteger(roster.total) || roster.total < 1) return false;
  return !(
    roster.editedFiles !== undefined &&
    roster.editedFiles.length > 0 &&
    roster.failed.length > 0
  );
}

/** The reason the record gives for refusing the merge, for the handback line. */
function landRefusal(run: LeanRun): string {
  const lastVerify = newestDecided(run.steps, "verify");
  const lastCi = newestDecided(run.steps, "ci");
  // A rosterless green names the roster, not "verify not green": the second sends an operator to
  // a gate that reported green.
  if (
    leanProjectRosterEnabled() &&
    lastVerify?.outcome?.kind === "green" &&
    !rosterEarnsLand(lastVerify.outcome)
  )
    return `land refused: ${ROSTER_LAND_REFUSAL}`;
  const unaccepted = leanProjectRosterEnabled() ? unacceptedTestEdits(run.steps) : [];
  if (lastVerify?.outcome?.kind === "green" && unaccepted.length > 0)
    return `land refused: ${unacceptedTestEditsRefusal(unaccepted)}`;
  return `land refused: verify not green (draft=${run.counters.draft}, last verify=${
    lastVerify?.outcome?.kind ?? "none"
  }, last ci=${lastCi?.outcome?.kind ?? "none"})`;
}

/**
 * Why a stamped `result` is not the answer its own step log gives, or `undefined` when it is.
 *
 * `result` is written only by `endRun`, which writes a terminal state, the code `exitCodeFor`
 * gives it, and a reason. The snapshot fields are a cache, not the record, so a resumed run has
 * to be able to say the stamp it holds could not have come from there. The check:
 *
 *   - the fold must actually have reached a terminal state;
 *   - the code must be the one that state exits with;
 *   - `landed` additionally needs the merge gate to hold of the log — the rule that matters,
 *     since a stamp on the file is read before either `land` gate runs.
 */
function stampedResultRefusal(
  file: string,
  derivedState: LeanState,
  run: LeanRun,
): string | undefined {
  const result = run.result;
  if (result === undefined) return undefined;
  if (!isTerminal(derivedState))
    return `${file}: stamped result disagrees with the step log (the log replays to ${derivedState}, which is not terminal, but the record carries ${JSON.stringify(result)})`;
  if (result.code !== exitCodeFor(derivedState))
    return `${file}: stamped result disagrees with the step log (${derivedState} exits ${exitCodeFor(derivedState)}, the record says ${result.code})`;
  if (derivedState === "landed" && !landEarned(run))
    return `${file}: stamped result disagrees with the step log (${landRefusal(run)}, yet the record claims ${result.code})`;
  return undefined;
}

/** The module's readings, exported as one object so the runner imports one name. */
export const engineFacts = {
  lastFailedRules,
  reasonFor,
  landEarned,
  landRefusal,
  stampedResultRefusal,
};
