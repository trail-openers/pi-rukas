/**
 * lean-specify-preserves-switch — the ONE reader of the switch that lets a `specify` child declare a
 * criterion it intends to KEEP working rather than break.
 *
 * On, a `submit_tests` row may carry `preserves: true`; a declared row whose file is green at the base is
 * frozen as a must-pass file instead of ending the cycle, and a run whose every test criterion is preserved
 * still hands back. Off, the `submit_tests` schema, the specify prompt and the step's recorded outcome are
 * the bytes from before the field existed: the declaration is neither offered nor read, so a green-at-base
 * file is the coverage gap it always was. Only the literal `"0"` turns it off, read at CALL time.
 *
 * Lives directly under `src/` rather than under `src/lean/`: it is a run-wide knob like the sibling
 * `lean-oracle-repair-switch.ts`, and the lean line cap counts only what lives in the engine directory.
 */

/** Whether a specify child may declare a criterion as one that must keep holding. */
export function leanSpecifyPreservesEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_SPECIFY_PRESERVES !== "0";
}
