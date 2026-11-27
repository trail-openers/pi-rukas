/**
 * lean-step-deadline-bound-switch — the ONE reader of the switch that lets a lean
 * step's child bound read the cycle deadline.
 *
 * Default ON: only the literal `"0"` takes it out, read at CALL time. Every other
 * value (`""`, `"false"`, `"NO"`, a mangled `" 0 "`) keeps the shipped behaviour,
 * because a switch a shell accident could flip is a lost cell waiting to happen — the
 * same discipline as `PI_ENSEMBLE_LEAN_REQUEST_STALL`, whose lever this sits beside.
 *
 * `0` means the bound is exactly what `WorkConfig.budgets` says and nothing else: the
 * pre-change arm, byte for byte (`test-lean-step-deadline-bound-off-arm.ts` proves the
 * identity against a golden captured from the base commit). Off, no run traces a
 * derivation it did not perform.
 */

/** The ONE reader of `PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND`. `0` is the only off value. */
export const leanStepDeadlineBoundEnabled = (): boolean =>
  process.env.PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND !== "0";
