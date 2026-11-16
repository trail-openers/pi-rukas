/**
 * lean/deadline-handback — the clock stops a working step, and whether the run still gets to
 * report.
 *
 * `deadlineStopsSteps` answers where step WORK ends and `engine.ts` stamps the run `handed-back`
 * where it stands. That is right for most stops, but not for a run whose newest work step is a
 * `fixed` review: `machine.ts` routes `fixed` back through `verify`, so origin holds bytes no
 * gate certified, and the step that says so — and moves origin back — is `handback`. Stamping
 * there meant that step never ran.
 *
 * So the engine routes instead of stamping, on one condition: the head rule of
 * `handback-heads.ts` says this log is standing over unverified bytes. That predicate keys on the
 * LOG and not on the stop cause, so the routing fires on the same shape the reporting step reports
 * on, and on nothing else.
 *
 * The extra step is affordable precisely because `REPORT_STATES` is exempt from
 * `deadlineStopsSteps`, so the report is the one step past the line the deadline cannot refuse.
 *
 * The switch (`PI_ENSEMBLE_LEAN_DEADLINE_HANDBACK`) is read at CALL time: with it off the engine
 * stamps where it stands.
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
 * Two reads, deliberately both: the switch, because an operator must be able to get the old
 * behaviour back; and the head rule, because a stop whose newest work step is anything but an
 * uncertified `fixed` review has no head to say anything about.
 *
 * `steps` rather than a whole run: the predicate reads the log and nothing else.
 */
export function deadlineStopShouldReport(steps: LeanRun["steps"]): boolean {
  if (!leanDeadlineHandbackEnabled()) return false;
  return handbackHeads(steps).applies;
}
