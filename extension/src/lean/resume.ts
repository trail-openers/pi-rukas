/**
 * lean/resume — deriving where a run actually is, from its step log.
 *
 * The engine loads a run and drives it. The run's `state` and `counters` are a CACHE by state.ts's own
 * contract ("not trusted as truth; `steps` is the record"), and this module is what makes that sentence mean
 * something: it folds the append-only log through the transition table and refuses a file whose snapshot the
 * fold cannot reproduce.
 *
 * THE FOLD ASSUMES ONE PROPERTY OF THE LOG, and it is the engine's, not the reader's: the log is append-only
 * and the engine writes ONE entry ahead for EVERY visit to a state, keyed `<issue>:<state>:<n>` where `n` is
 * the number of earlier entries for that state. So a log a drive wrote has an entry for every state the walk
 * stood in, in order, and this fold needs no exemptions to reproduce it.
 *
 * Two positions the snapshot may legitimately hold: the fold's own (`pos`), and the one immediately before its
 * last step (`before`) — a crash that took the process between recording an outcome and applying it. Anything
 * else throws and `runLean` never touches a handler.
 */

import { hasTransition, next } from "./machine.ts";
import {
  INITIAL_COUNTERS,
  type LeanRun,
  type LeanState,
  LeanStateError,
  type Outcome,
  type Position,
  REPORT_STATES,
  type RunCounters,
  type Step,
  stepKey,
} from "./state.ts";

/**
 * The position the step log implies, refusing a run whose snapshot disagrees.
 *
 * Each fold consumes the log's next entry in the ORDER IT WAS WRITTEN, which is what picks the right attempt
 * of a state the run entered twice.
 *
 * The position is DERIVED, never taken from the snapshot: the snapshot is a cache, and a replay path applies
 * recorded outcomes without running their handlers. Refuse the file rather than repair it.
 */
export function verifiedPosition(file: string, run: LeanRun): Position {
  const { pos, before, decided } = foldLog(run, file);
  // A snapshot may lag the log by exactly one step and no more.
  if (!samePosition(run, pos) && !(decided && samePosition(run, before)))
    throw new LeanStateError(
      `${file}: snapshot disagrees with the step log (snapshot ${run.state} ${JSON.stringify(
        run.counters,
      )}, log replays to ${pos.state} ${JSON.stringify(pos.counters)}${
        decided ? ` or (one step back) ${before.state} ${JSON.stringify(before.counters)}` : ""
      })`,
    );
  // The DERIVED position, not the snapshot's.
  return pos;
}

/**
 * The fold on its own, without the snapshot judgement. `verifiedPosition` is the only caller in src/; it is
 * exported for the test fixtures.
 */
export function foldLog(
  run: LeanRun,
  where = "step log",
): {
  pos: Position;
  before: Position;
  decided: boolean;
} {
  const log = run.steps;
  let pos: Position = { state: "ready", counters: { ...INITIAL_COUNTERS } };
  let before = pos;
  // How many entries of each state precede the entry being folded — the number the engine's own key for that
  // entry carries.
  const seen: Partial<Record<LeanState, number>> = {};
  for (let i = 0; i < log.length; i++) {
    const s = log[i] as (typeof log)[number];
    const n = seen[s.state] ?? 0;
    seen[s.state] = n + 1;
    const at = (m: string): never => {
      throw new LeanStateError(
        `${where}: snapshot disagrees with the step log (${m} at step ${i + 1} of ${log.length})`,
      );
    };
    if (s.state !== pos.state) {
      // The engine's one move that arrives with a visit but no verdict to carry: the deadline's route into the
      // report (`driveLoop`, gated by `deadlineStopShouldReport`). When the clock refuses the step whose verdict
      // would have owed the move, the run is moved into `handback` so the comment, the rewind and the head
      // fields actually run — and there is no verdict to put on an entry for that visit.
      //
      // `isReportRoute` keeps the exemption as narrow as the move, and reads the WALK and the log rather than
      // the entry being judged, so a record cannot vouch for itself. Any earlier report entry makes this a
      // fabrication and the exemption is withheld.
      const reportedEntry = s.state === "handback";
      const firstReportEntry = (seen[s.state] ?? 1) === 1;
      if (!(reportedEntry && firstReportEntry && isReportRoute(log)))
        at(`step ${s.key} belongs to ${s.state} but the walk stands at ${pos.state}`);
      seen.handback = (seen.handback ?? 1) + 1;
      // A route is a visit, so the walk takes it; counters carry across unchanged.
      before = pos;
      pos = { state: "handback", counters: pos.counters };
      // Its key is the REPORT's own (`<issue>:handback:<n>`) — but it is not skipped: a routed visit still has
      // to be the entry the engine's key rule would have written.
      if (s.key !== stepKey(run.issue, "handback", n))
        at(`step ${s.key} is not the ${n}th entry for handback`);
    } else if (s.key !== stepKey(run.issue, s.state, n)) {
      at(`step ${s.key} is not the ${n}th entry for ${s.state}`);
    }
    if (s.outcome === undefined) {
      // The write-ahead of the step this run is about to re-run: a drive saves the file at that moment, so the
      // position it persisted is exactly the one the fold stands on.
      if (i !== log.length - 1) at(`step ${s.key} carries no outcome but is not the newest step`);
      break;
    }
    if (!hasTransition(s.state, s.outcome.kind)) {
      // A thrown handler or a kind the table has no arrow for: the engine records it and ends the run itself,
      // so it is the last entry the log will ever hold.
      if (i !== log.length - 1)
        at(`step ${s.key} + ${JSON.stringify(s.outcome.kind)} has no arrow and is not last`);
      if (run.state !== "handed-back" || run.result === undefined)
        at(`step ${s.key} carries the outcome a drive halts on, but the run is not handed-back`);
      return { pos: { state: "handed-back", counters: pos.counters }, before, decided: true };
    }
    before = pos;
    pos = next({ ...run, state: pos.state, counters: pos.counters }, s.outcome);
  }
  return { pos, before, decided: log.length > 0 && log[log.length - 1]?.outcome !== undefined };
}

/**
 * Is this `handback` entry the engine's deadline route into the report, rather than an invented visit?
 *
 * Three conditions, none read from the entry being judged, so a log cannot describe its way into being legal:
 *
 *   - it is the run's FIRST report entry and belongs to `handback`;
 *   - the log still ends on this `handback` entry — a route is written to end the log;
 *   - the log's newest DECIDED work step is a `fixed` review with no decided `verify` behind it.
 */
function isReportRoute(log: Step[]): boolean {
  if ((log[log.length - 1] as Step | undefined)?.state !== "handback") return false;
  const newestWork = [...log]
    .reverse()
    .find(
      (s) => s.outcome !== undefined && !(REPORT_STATES as readonly string[]).includes(s.state),
    );
  if (newestWork?.state !== "review" || newestWork.outcome?.kind !== "fixed") return false;
  const at = log.indexOf(newestWork);
  return !log.some((s, i) => i > at && s.state === "verify" && s.outcome !== undefined);
}

/**
 * Do a snapshot and a position agree? Field by field, because `JSON.stringify` compares key ORDER as well as
 * value.
 */
function samePosition(run: LeanRun, pos: Position): boolean {
  return run.state === pos.state && sameCounters(run.counters, pos.counters);
}

function sameCounters(a: RunCounters, b: RunCounters): boolean {
  return (
    a.buildAttempts === b.buildAttempts &&
    a.challengeDone === b.challengeDone &&
    a.reviewDone === b.reviewDone &&
    a.ciFixUsed === b.ciFixUsed &&
    a.draft === b.draft
  );
}
