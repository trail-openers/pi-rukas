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
import { leanReviewIncompleteHeadEnabled } from "../lean-review-incomplete-head-switch.ts";
import { handbackHeads } from "./handback-heads.ts";
import { hasTransition, next } from "./machine.ts";
import {
  INITIAL_COUNTERS,
  type LeanRun,
  type LeanState,
  LeanStateError,
  type Position,
  REPORT_STATES,
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
      if (i !== log.length - 1 && !isReportRoute(log))
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
      const routed =
        s.state === "review" &&
        s.outcome.kind === "error" &&
        i === log.length - 2 &&
        log[i + 1]?.state === "handback" &&
        log[i + 1]?.outcome === undefined &&
        log.filter((r) => r.state === "handback").length === 1 &&
        leanReviewIncompleteHeadEnabled() &&
        reportRouteFor(s, log.slice(0, i + 1)) &&
        handbackHeads(log.slice(0, i + 1)).applies;
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
 * Is this `handback` entry the engine's route into the report, rather than an invented visit?
 *
 * Three conditions, none read from the entry being judged: it is the run's FIRST report entry; the log ends
 * on it; and the newest DECIDED work step is a `fixed` review with no decided `verify` behind it — or, with
 * #2667 on, an `error` review whose newest decided `verify` named a head. The pair is exactly what
 * `handbackHeads` answers `applies` for, which is the premise the routing acts on: an entry the routing
 * writes must be one the fold will admit, and a run the rule refuses must not have one at all.
 */
function isReportRoute(log: Step[]): boolean {
  if ((log[log.length - 1] as Step | undefined)?.state !== "handback") return false;
  // The routing's record ends on the report's WRITE-AHEAD: the visit the route wrote, carrying no
  // verdict, because the verdict is the terminal result the run ends on rather than a second
  // entry. So the step that decides this record's shape is the newest work step BEFORE that entry,
  // and the fold's rule for a no-arrow entry is the same one — a routed run's log is a prefix of
  // the log it would have written had the throw ended it. One report entry only: a second is a
  // step the walk took on its own and is judged at the move, not here.
  const last = log[log.length - 1] as Step | undefined;
  if (last?.state !== "handback") return false;
  if (log.slice(0, -1).some((s) => s.state === "handback")) return false;
  const body = last.outcome === undefined ? log.slice(0, -1) : log;
  const newestWork = [...body]
    .reverse()
    .find(
      (s) => s.outcome !== undefined && !(REPORT_STATES as readonly string[]).includes(s.state),
    );
  if (newestWork?.state !== "review") return false;
  return reportRouteFor(newestWork, body);
}

/**
 * Does the newest work step `newest` make the report entry the engine's route? The fold asks it
 * twice, about two logs: at the MOVE, and at a no-arrow entry (#2667's routed record).
 */
function reportRouteFor(newest: Step, log: Step[]): boolean {
  const at = log.indexOf(newest);
  if (newest.outcome?.kind === "fixed") return true;
  // The errored arm (#2667), and only with the switch on: the run the rule would hand back at a
  // certified head is the run whose report entry this is. A green that named no head names nothing
  // to ship, so it opens no route — and "named a head" is the head rule's own reading, asked over
  // the same log the fold is judging, so the two readers cannot drift apart.
  return (
    newest.outcome?.kind === "error" &&
    leanReviewIncompleteHeadEnabled() &&
    handbackHeads(log).verifiedHead !== undefined
  );
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
