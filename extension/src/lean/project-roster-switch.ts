/**
 * lean/project-roster-switch — the ONE reader of the lever that decides whether `verify` judges
 * the PROJECT's own pre-existing tests alongside the run's frozen contract.
 *
 * The rule it gates lives in `verify-roster.ts` and `verify.ts`, `ready`'s run-start check and the
 * land gate; this module owns only the lever, and no renderer consults it. Off means no
 * enumeration, no project test run, no roster on the record, no hand-back for a missing one, no
 * run-start refusal of a non-pytest `verify.test`, and a land gate that asks only the verdict
 * KINDS it asked before the field existed. Only the literal `"0"` takes the roster out, read at CALL time.
 */

/** Whether `verify` builds and enforces the project-test roster. */
export function leanProjectRosterEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_PROJECT_ROSTER !== "0";
}
