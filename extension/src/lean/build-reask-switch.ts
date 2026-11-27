/**
 * build-reask-switch — the ONE reader of the switch that lets a build step spend its one
 * session continuation on a developer turn that produced nothing.
 *
 * Default ON: only the literal `"0"` takes it out, read at CALL time, the same discipline as
 * `PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK` and `PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND` — a switch a
 * shell accident could flip is a lost cell waiting to happen. Every other value (`""`, `"false"`,
 * `"NO"`, a mangled `" 0 "`) keeps the shipped behaviour.
 *
 * `0` is the pre-change arm byte for byte: no detection, no continuation child, no extra cost row,
 * and the `exhausted` reason stays the head the existing suites pin
 * (`test-lean-build-reask-off-arm.ts` proves the identity against a golden captured from the base
 * commit, with the on-arm's own answer asserted different beside it).
 */

/** The ONE reader of `PI_ENSEMBLE_LEAN_BUILD_REASK`. `0` is the only off value. */
export const leanBuildReaskEnabled = (): boolean =>
  process.env.PI_ENSEMBLE_LEAN_BUILD_REASK !== "0";
