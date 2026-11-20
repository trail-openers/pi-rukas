/**
 * lean/fixer-truncation-reask-switch — the ONE reader of the switch that decides whether a
 * review fixer cut off at its output-token limit gets a second turn in its own session.
 *
 * The shape of the defect: a fixer spends its turns reading, then ends its last substantive
 * turn with `stopReason: "length"` at the model's output cap without ever calling a write
 * tool. Pi still exits 0, so `ok` is true, no kill cause is stamped, and the step's only
 * predicate for "did the wave achieve anything" — `assertFixAdvanced`, which reads two heads
 * out of git — sees a branch that never moved and refuses the wave as "review fix produced no
 * change". A run whose head every gate had already verified is handed back over a turn that
 * was never finished.
 *
 * On (the shipped default) the step notices the cut — the child's OWN recorded stop reason and
 * its own recorded tool calls, never its prose — and continues that same session once, in the
 * same tree behind the same fence, before it judges "no change". Only the literal `"0"` puts
 * today's behaviour back: no detection, no continuation, and the `CAUSE_NO_CHANGE` message,
 * the handback body and the headless `failure.message` byte-identical to what this build wrote
 * before the continuation existed. That is what makes shipping it on by default safe, and
 * `test-lean-review-fixer-truncation-off-arm.ts` pins it against goldens captured from the
 * pre-change build rather than re-derived from the modules under change.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file runs in one bun
 * process and pins off/on arms with a `withEnv` helper, so a load-time read would let one
 * file's pin silently change the next file's arm.
 */

/** Whether a truncated review fixer is continued once before the wave is judged. */
export function leanFixerTruncationReaskEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_FIXER_TRUNCATION_REASK !== "0";
}
