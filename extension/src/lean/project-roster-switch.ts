/**
 * lean/project-roster-switch — the ONE reader of the lever that decides whether `verify` judges
 * the PROJECT's own pre-existing tests alongside the run's frozen contract.
 *
 * The rule it gates lives in `verify-roster.ts` and `verify.ts`; this module owns only the lever,
 * and no renderer consults it — the verify step's call site is the only reader. Off means no
 * enumeration, no project test run, no roster on the record, no hand-back for a missing one, and a
 * land gate that asks only the verdict KINDS it asked before the field existed. Only the literal
 * `"0"` takes the roster out.
 *
 * Read at CALL time, not at module load: every lean smoke file runs in one bun process and pins
 * off/on arms with `lib/env-scope.ts` `withEnv`, so a load-time read would let one file's pin
 * disable the next file's roster.
 */

/** Whether `verify` builds and enforces the project-test roster. */
export function leanProjectRosterEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_PROJECT_ROSTER !== "0";
}
