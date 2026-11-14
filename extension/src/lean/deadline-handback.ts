/**
 * lean/deadline-handback — the clock stops a working step, and whether the run
 * still gets to report.
 *
 * `deadlineStopsSteps` answers where step WORK ends; `engine.ts` acts on it by
 * stamping the run `handed-back` where it stands. That is right for most stops —
 * a run out of time on its third build has nothing to report but that — but it
 * was wrong for the one stop this project exists to survive: a run whose newest
 * work step is a `fixed` review. `machine.ts` routes `fixed` back through
 * `verify`, so origin is holding bytes no gate ever certified, and the step that
 * says so — and moves origin back — is `handback`. Stamping the run where it
 * stood meant that step never ran: the rewind, the head fields and the comment
 * were all inert on exactly the shape they were written for, and a host that
 * reads only its handoff saw nothing at all.
 *
 * So the engine routes instead of stamping, on one condition: the head rule of
 * `handback-heads.ts` says this log is standing over unverified bytes. That
 * predicate is the whole gate — it keys on the LOG and not on the stop cause, so
 * the routing fires on the same shape the reporting step reports on, and on
 * nothing else. Every other deadline stop is the plain stop it always was.
 *
 * Routing rather than stamping is not free: the run takes one more step, the
 * report's own. That is affordable precisely because `REPORT_STATES` is exempt
 * from `deadlineStopsSteps`, so the report the run is routed into is the one step
 * past the line the deadline cannot refuse — the same reason `work` never parks
 * its own handoff. The routed run's record then reads like any other handback:
 * its newest step is the report, and `result` is stamped from its verdict.
 *
 * The switch (`PI_ENSEMBLE_LEAN_DEADLINE_HANDBACK`) is read at CALL time, like
 * its sibling in `verified-handback-switch.ts`: with it off the engine stamps
 * where it stands, which is what it did before this routing existed.
 */

import { handbackHeads } from "./handback-heads.ts";
import type { LeanRun } from "./state.ts";

/** Whether a deadline stop that left a fixed review unverified reports instead of stamping. */
export function leanDeadlineHandbackEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_DEADLINE_HANDBACK !== "0";
}

/**
 * Whether THIS stop should be answered by running the report.
 *
 * Two reads, deliberately both: the switch, because an operator must be able to
 * get the old behaviour back byte for byte; and the head rule, because a deadline
 * stop whose newest work step is anything but an uncertified `fixed` review has
 * no head to say anything about, and giving it a `handback` step would be the
 * engine inventing a report for a run that earned none.
 *
 * `steps` rather than a whole run: the predicate reads the log and nothing else,
 * and a caller cannot pass a snapshot the log does not support.
 */
export function deadlineStopShouldReport(steps: LeanRun["steps"]): boolean {
  if (!leanDeadlineHandbackEnabled()) return false;
  return handbackHeads(steps).applies;
}
