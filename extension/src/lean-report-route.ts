/**
 * lean-report-route — the two readings that say a `handback` entry is the engine's own route
 * into the reporting step rather than a visit the run invented.
 *
 * The fold in `lean/resume.ts` refuses a log it cannot replay through the transition table.
 * The routing is the one move the runner makes that the table does not route, so the fold asks
 * this module instead of keeping the shape in its own file: the module owns the predicate and
 * its two switch reads, and the fold consults the answer. Nothing here starts work or writes a
 * record; it only judges a log.
 */
import { leanReviewIncompleteHeadEnabled } from "./lean-review-incomplete-head-switch.ts";
import { handbackHeads } from "./lean/handback-heads.ts";
import { REPORT_STATES, type Step } from "./lean/state.ts";

/**
 * Is this `handback` entry the engine's route into the report, rather than an invented visit?
 *
 * The conditions are read off the WALK and the log, never off the entry being judged: the log
 * ends on the report entry, it is the run's only one, and the newest DECIDED work step before it
 * is a `fixed` review with no decided `verify` behind it — or, with #2667 on, an `error` review
 * whose newest decided `verify` named a head. The pair is exactly what `handbackHeads` answers
 * `applies` for, which is the premise the routing acts on: an entry the routing writes must be
 * one the fold will admit, and a run the rule refuses must not have one at all.
 */
export function isReportRoute(log: Step[]): boolean {
  const last = log[log.length - 1] as Step | undefined;
  if (last?.state !== "handback") return false;
  // One report entry only: a second is a step the walk took on its own and is judged at the
  // move, not here.
  if (log.slice(0, -1).some((s) => s.state === "handback")) return false;
  // The routing's record ends on the report's WRITE-AHEAD: the visit the route wrote, carrying
  // no verdict, because the verdict is the terminal result the run ends on rather than a second
  // entry. So the step that decides this record's shape is the newest work step BEFORE that
  // entry, and the fold's rule for a no-arrow entry is the same one — a routed run's log is a
  // prefix of the log it would have written had the throw ended it.
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
 * about the log it is judging, and the routing acts on the same answer: an entry the routing writes
 * must be one the fold admits, and a run the head rule refuses must have no report entry at all.
 */
export function reportRouteFor(newest: Step, log: Step[]): boolean {
  if (newest.outcome?.kind === "fixed") return true;
  // The errored arm (#2667), and only with the switch on: the run the head rule would hand back is the
  // run whose report entry this is, and only over bytes its own gate NAMED — the head rule's reading is
  // the judge, asked over the log the fold is judging, so the two readers cannot drift apart.
  return (
    newest.outcome?.kind === "error" &&
    leanReviewIncompleteHeadEnabled() &&
    handbackHeads(log).verifiedHead !== undefined
  );
}

/**
 * Is the entry at `i` a routed throw, with the report's own entry after it and nothing of the walk
 * between? Stated as narrowly as the move, and only on the side of the knob the routing runs on: the
 * route predicate and the head rule are consulted, not approximated.
 */
export function routedThrowEntry(log: Step[], i: number): boolean {
  const s = log[i] as Step | undefined;
  const report = log[i + 1];
  return (
    s?.state === "review" &&
    s.outcome?.kind === "error" &&
    i === log.length - 2 &&
    report?.state === "handback" &&
    log.filter((r) => r.state === "handback").length === 1 &&
    reportRouteFor(s, log.slice(0, i + 1))
  );
}
