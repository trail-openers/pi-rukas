/**
 * lean/handback-report-bound-switch — the ONE reader of the switch that decides
 * whether the routed deadline report is bounded by a wall of its own.
 *
 * A deadline stop that routes into the report leaves step work behind at
 * `deadline − handoffAllowanceMs()`, and the report is the one step the stop test
 * exempts (`deadlineStopsSteps`'s `REPORT_STATES` branch). That exemption is what
 * lets the run still deliver its document — and it is also what left the report
 * with no wall at all: it is not started through the runner's step machinery, so it
 * gets neither the step budget nor the cycle clamp, and a reporting step that never
 * returns holds the run past the allowance the routing exists to protect. An
 * external wrapper's kill then records a kill instead of the handback.
 *
 * `PI_ENSEMBLE_LEAN_REPORT_BOUND=0` puts that unbounded await back byte for byte:
 * the engine awaits the reporting handler and nothing else, so a hung report hangs
 * the run exactly as it did before the bound. Only the literal `"0"` turns the
 * bound off; unset and any other value leave it on.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file
 * runs in one bun process and pins off/on arms with `withEnv`, so a load-time
 * read would let one file's pin silently disable the rule in the next.
 */

/** Whether the routed report is bounded by the handoff allowance. */
export function leanReportBoundEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_REPORT_BOUND !== "0";
}
