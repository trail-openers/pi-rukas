/**
 * work-driver-timeout-flag-precedence-switch — the ONE reader of the switch that
 * decides whether an explicit `--timeout` outranks `PI_ENSEMBLE_CYCLE_BUDGET_MS`.
 *
 * A host that exports a 60-minute budget arms every cycle it starts; a caller who then
 * asks for one run of 165 minutes with `pi-rukas-headless work-lean --timeout 165` was
 * cut at 60 minutes with nothing on stderr saying which number bit. An explicit flag is
 * the caller's word about THIS run and the env value is the host's default, so the flag
 * should win — but the order was never documented either way, so "the env always wins"
 * was the only behaviour anyone could point at.
 *
 * `PI_ENSEMBLE_CYCLE_DEADLINE` is not affected: it is an absolute epoch set by a host
 * that owns the clock, and an absolute arm is a different kind of instruction from a
 * duration. `resolveCycleDeadline` still weighs it above both durations.
 *
 * `PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE=0` restores today's order byte for byte — same
 * resolved arms, and no line on stderr for a disagreement. Only the literal `"0"` turns
 * the rule off.
 *
 * The env var is read at CALL time, not at module load: the offline suites pin off/on
 * arms with `withEnv` inside one bun process, and a load-time read would let one file's
 * pin silently disable the rule in the next.
 */

/** The switch's env name, spelled in one place so the reader, the warning's remedy tail and
 *  the host roster cannot drift apart on how the knob is written. */
export const SWITCH = "PI_ENSEMBLE_TIMEOUT_FLAG_PRECEDENCE";

/** Whether an explicit `--timeout` outranks the host's exported budget. */
export function timeoutFlagPrecedenceEnabled(): boolean {
  return process.env[SWITCH] !== "0";
}
