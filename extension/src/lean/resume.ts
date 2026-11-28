/**
 * lean/resume — deriving where a run actually is, from its step log.
 *
 * The engine loads a run and drives it. The run's `state` and `counters` are a CACHE by state.ts's own
 * contract ("not trusted as truth; `steps` is the record"), and this module makes that sentence mean
 * something: it folds the append-only log through the transition table and refuses a file whose snapshot the
 * fold cannot reproduce.
 *
 * THE FOLD ASSUMES ONE PROPERTY OF THE LOG, and it is the engine's: the log is append-only and the engine
 * writes ONE entry ahead for EVERY visit, keyed `<issue>:<state>:<n>`. So a log a drive wrote has an entry for
 * every state the walk stood in, and the fold needs no exemptions to reproduce it.
 *
 * Two positions the snapshot may legitimately hold: the fold's own (`pos`), and the one before its last step
 * (`before`) — a crash between recording an outcome and applying it. Anything else throws.
 */
import { isReportRoute, routedThrowEntry } from "../lean-report-route.ts";
import { hasTransition, next } from "./machine.ts";
import {
  INITIAL_COUNTERS,
  type LeanRun,
  type LeanState,
  LeanStateError,
  type Position,
  type RunCounters,
  type Step,
  stepKey,
} from "./state.ts";

/**
 * The position the step log implies, refusing a run whose snapshot disagrees.
 *
 * Each fold consumes the log's next entry in the ORDER IT WAS WRITTEN, which picks the right attempt of a
 * state the run entered twice.
 *
 * The position is DERIVED, never taken from the snapshot. Refuse the file rather than repair it.
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
 * The fold on its own, without the snapshot judgement. Exported for the test fixtures.
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
  // How many entries of each state precede the one being folded — the number its key carries.
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
      // The engine's one move that arrives with a visit but no verdict: the deadline's route into the report.
      // When the clock refuses the step whose verdict would have owed the move, the run is moved into
      // `handback` so the comment, the rewind and the head fields actually run.
      //
      // `isReportRoute` keeps the exemption as narrow as the move, reading the WALK and the log rather than the
      // entry being judged, so a record cannot vouch for itself.
      const reportedEntry = s.state === "handback";
      const firstReportEntry = (seen[s.state] ?? 1) === 1;
      if (!(reportedEntry && firstReportEntry && isReportRoute(log)))
        at(`step ${s.key} belongs to ${s.state} but the walk stands at ${pos.state}`);
      seen.handback = (seen.handback ?? 1) + 1;
      // A route is a visit, so the walk takes it; counters carry across.
      before = pos;
      pos = { state: "handback", counters: pos.counters };
      // Its key is the report's own; a routed visit still has to be what the key rule would have written.
      if (s.key !== stepKey(run.issue, "handback", n))
        at(`step ${s.key} is not the ${n}th entry for handback`);
    } else if (s.key !== stepKey(run.issue, s.state, n)) {
      at(`step ${s.key} is not the ${n}th entry for ${s.state}`);
    }
    if (s.outcome === undefined) {
      // The write-ahead of the step this run is about to re-run: a drive saves at that moment, so the
      // position it persisted is the one the fold stands on. #2667's routed record is the one shape
      // where a later save follows the write-ahead: the throw the runner stamped first, then the
      // report's visit, with the verdict left for the save that ends the run. The route's own
      // predicate decides that pairing; nothing else may put an entry after a write-ahead.
      if (i !== log.length - 1 && !writeAheadThenRoute(log, i))
        at(`step ${s.key} carries no outcome but is not the newest step`);
      break;
    }
    if (!hasTransition(s.state, s.outcome.kind)) {
      // A thrown handler or a kind with no arrow: the engine ends the run itself, so this is
      // normally the last entry. #2667's route is the exception, stated as narrowly as the move:
      // the throw's entry, then exactly one report entry with nothing of the walk between them,
      // the head rule holding that an errored review over a certified head owes that report, and
      // only on the side of the knob the routing runs on. `reportRouteFor` (over the log up to the
      // throw) and the head rule are the judges, consulted rather than approximated.
      const routed = routedThrowEntry(log, i) || reportEntryOfThrow(log, s.outcome.kind);
      if (i !== log.length - 1 && !routed)
        at(`step ${s.key} + ${JSON.stringify(s.outcome.kind)} has no arrow and is not last`);
      // A routed throw is a run still OWING its report (a crash between the runner's two saves):
      // it folds UNDECIDED, still standing at `review`. A decided fold would let a forged
      // `handed-back` snapshot past the one-step lag the snapshot is allowed. Anywhere else the
      // no-arrow entry is the outcome a drive halts on, and the run has to be stamped.
      if (routed && run.result === undefined) {
        if (run.state !== "review")
          at(`step ${s.key} is a throw the route handed on, but the run says ${run.state}`);
        return { pos, before, decided: false };
      }
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
 * Is this log the record a routed throw LEFT — the throw's entry, then its report's own verdict,
 * with the run already stamped? The crash shape (`routedThrowEntry`) has the report's write-ahead;
 * this is the FINISHED record. Both must fold, or a handed-back issue could never be opened again.
 */
function reportEntryOfThrow(log: Step[], kind: string): boolean {
  return kind === "error" && isReportRoute(log);
}

/**
 * Is the verdictless entry at `i` the report's own write-ahead, standing where a routed throw left it?
 * The route predicate judges the log (#2667's routed record is the one shape where a save follows a
 * write-ahead), and the entry's own position says it is the last thing the run wrote.
 */
function writeAheadThenRoute(log: Step[], i: number): boolean {
  return i === log.length - 1 && isReportRoute(log);
}

/**
 * Do a snapshot and a position agree? Field by field — `JSON.stringify` compares key order as well as value.
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
    a.draft === b.draft &&
    // The spent repair round is as much a cap as the others, and the one statement that
    // a run may not buy the round again. Left out, a hand-edited file could carry any
    // value here and the fold would agree with it, which is a second round for free.
    a.repairsSpent === b.repairsSpent
  );
}
