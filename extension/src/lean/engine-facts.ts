/**
 * lean/engine-facts — the readings of a run's step log the runner consults but
 * does not itself perform: `reasonFor` words why a run ended, and the merge gate
 * (`landEarned`, its refusal wording, and the stamp check that re-asks the gate).
 * All are pure reads of the record, sharing `newestDecided` and the report-state
 * exclusion, which is why they live together.
 */

import { REPORT_FAILED_KIND, exitCodeFor } from "./machine.ts";
import { type LeanRun, type LeanState, type Outcome, isTerminal, newestDecided } from "./state.ts";

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
  // A refusal reaches here as the outcome of its REPORTING step, which carries
  // the rules it posted (or failed to post) — `ready`'s and `specify`'s own
  // outcomes live in the log, so they are read back from there rather than
  // copied onto the run. One fact, two readers: the rules alone for a comment
  // that went out, and the rules plus the delivery failure for one that did
  // not, so a summary line never reads as a clean verdict somebody was told.
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
 * Has this run earned the merge? Its own record must currently say so: the newest
 * DECIDED `verify` AND the newest DECIDED `ci` both green, and no `draft` marker
 * left standing. `ci`'s green is what the table routes on and `verify`'s is what
 * the run's own gate said.
 */
function landEarned(run: LeanRun): boolean {
  if (run.counters.draft) return false;
  return (
    newestDecided(run.steps, "verify")?.outcome?.kind === "green" &&
    newestDecided(run.steps, "ci")?.outcome?.kind === "green"
  );
}

/** The reason the record gives for refusing the merge, for the handback line. */
function landRefusal(run: LeanRun): string {
  const lastVerify = newestDecided(run.steps, "verify");
  const lastCi = newestDecided(run.steps, "ci");
  return `land refused: verify not green (draft=${run.counters.draft}, last verify=${
    lastVerify?.outcome?.kind ?? "none"
  }, last ci=${lastCi?.outcome?.kind ?? "none"})`;
}

/**
 * Why a stamped `result` is not the answer its own step log gives, or
 * `undefined` when it is.
 *
 * `result` is written only by `endRun`, and `endRun` writes exactly three things: a
 * terminal state, the code `exitCodeFor` gives that state, and a reason. A resumed run
 * therefore has to be able to say the stamp it holds could not have come from there, or
 * the durable verdict is whatever the last writer of those fields chose — and `state.ts`
 * says plainly that the snapshot fields are a cache, not the record. The check:
 *
 *   - the fold must actually have reached a terminal state (a stamp on a non-terminal
 *     position describes a run nobody ended);
 *   - the code must be the one that state exits with;
 *   - `landed` additionally needs the merge gate to hold of the log, so the merge a
 *     stamp claims is the merge the record earned — the rule that matters, since a
 *     stamp on the file is read before either `land` gate runs.
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
