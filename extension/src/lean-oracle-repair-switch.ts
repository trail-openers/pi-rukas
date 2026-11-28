/**
 * lean-oracle-repair-switch — the ONE reader of the switch that lets a build run repair a wrong frozen
 * test once instead of handing the run back.
 *
 * On, a blocked report the driver proved (the named frozen files came back RED under the project's own
 * `verify.test` at the builder's head) routes the run into ONE bounded specify-repair round when the run has
 * no repair spent yet. Off, the same verified report is the ordinary handback the release made before the
 * repair existed. Only the literal `"0"` turns it off, read at CALL time, so a host can flip it between two
 * runs in one process.
 *
 * Lives directly under `src/` rather than under `src/lean/`: it is a run-wide knob like the sibling
 * `lean-step-deadline-bound-switch.ts`, and the lean line cap counts only what lives in the engine directory.
 */

/** Whether a driver-proven blocked report may spend the run's one repair round. */
export function leanOracleRepairEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_ORACLE_REPAIR !== "0";
}
