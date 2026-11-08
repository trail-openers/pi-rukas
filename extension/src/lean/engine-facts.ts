/**
 * lean/engine-facts — the four readings of a run's step log the runner consults
 * but does not itself perform (#1920 split, AGENTS.md §12).
 *
 * `reasonFor` words why a run ended; `lastFailedRules` recovers the rules a
 * refusal posted; `landEarned` and `landRefusal` are the merge gate and its
 * explanation; `stampedResultRefusal` checks a resumed run's stamped `result`
 * against the log that is supposed to have earned it. All four are pure reads of
 * the record — they share `newestDecided` and the report-state exclusion, and
 * one of them (`stampedResultRefusal`) has to ask `landEarned` the same question
 * the arrival gate asks, which is exactly why they live together.
 *
 * `landEarned` is a parameter of `stampedResultRefusal` rather than an import of
 * this module's own: the runner passes the one it gates arrivals with, so a
 * stamp can never be judged by a different rule than the merge is.
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
 * Has this run earned the merge? Its own record must currently say so: the
 * newest DECIDED `verify` AND the newest DECIDED `ci` both green, and no
 * `draft` marker left standing. `ci`'s green is what the table routes on and
 * `verify`'s is what the run's own gate said — a recorded `ci:green` read
 * over a later red verify is the shape that used to walk into the merge.
 */
export function landEarned(run: LeanRun): boolean {
  if (run.counters.draft) return false;
  return (
    newestDecided(run.steps, "verify")?.outcome?.kind === "green" &&
    newestDecided(run.steps, "ci")?.outcome?.kind === "green"
  );
}

/** The reason the record gives for refusing the merge, for the handback line. */
export function landRefusal(run: LeanRun): string {
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
 * `result` is written only by `endRun`, and `endRun` writes exactly three
 * things: a terminal state, the code `exitCodeFor` gives that state, and a
 * reason. A resumed run therefore has to be able to say that the stamp it is
 * holding could not have come from there, or the durable verdict is whatever
 * the last writer of those two fields chose — and `state.ts` says plainly
 * that the snapshot fields are a cache, not the record. These three rules are
 * that claim turned back into a check:
 *
 *   - the fold must actually have reached a terminal state (a stamp on a
 *     non-terminal position describes a run nobody ended);
 *   - the code must be the one that state exits with;
 *   - `landed` additionally needs `landEarned` to hold of the log, so the
 *     merge a stamp claims is the merge the record earned.
 *
 * The third rule is the one that matters: `land` is gated on the arrival in
 * `apply()` and on the derived position in `runLean`, and a stamp is read
 * BEFORE either when it is already on the file.
 */
export function stampedResultRefusal(
  file: string,
  derivedState: LeanState,
  run: LeanRun,
  earned: (run: LeanRun) => boolean = landEarned,
): string | undefined {
  const result = run.result;
  if (result === undefined) return undefined;
  if (!isTerminal(derivedState))
    return `${file}: stamped result disagrees with the step log (the log replays to ${derivedState}, which is not terminal, but the record carries ${JSON.stringify(result)})`;
  if (result.code !== exitCodeFor(derivedState))
    return `${file}: stamped result disagrees with the step log (${derivedState} exits ${exitCodeFor(derivedState)}, the record says ${result.code})`;
  if (derivedState === "landed" && !earned(run))
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
