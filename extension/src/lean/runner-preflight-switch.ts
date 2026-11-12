/**
 * lean/runner-preflight-switch — the ONE reader of the switch that decides
 * whether a specify run pays for the runner preflight and the submodule
 * re-initialisation.
 *
 * Both behaviours are #2179's and both were shipped with no switch: with every
 * other lean switch off, `specify` still differed from v0.14.71 by one runner
 * invocation per step, one `git submodule update --init --recursive` per reset,
 * and — the part an operator actually feels — the fact that a preflight or a
 * submodule failure ends the run `handed-back` at exit 10 where v0.14.71
 * declined `not-ready` at 11. So an operator comparing a run against the older
 * release cannot tell the two apart, and a project whose runner refuses an
 * empty file has no way back to a release that ran it anyway.
 *
 * `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0` restores v0.14.71 byte for byte in the
 * three places #2179 changed: the probe (not written, not run, so a runner that
 * dies before collection no longer throws), the submodule calls (no reset asks
 * git to populate anything), and the decline's WORDING for a child that submitted
 * nothing (v0.14.71's `criterion <id> has no red test`). The silence predicate
 * and its single retry are NOT switched — they exist in v0.14.71 and only the
 * rule that WORDS them does. `observeVerdict` is never switched either: it is an
 * observation seam that reaches no outcome.
 *
 * The gate sits inside `resetWorktreeToBase` rather than in its callers because
 * the resets are made in six places; a per-caller check leaves some of them
 * paying the initialisation with the switch off.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file
 * runs in one bun process and pins off/on arms with `withEnv`, so a load-time
 * read would let one file's pin silently disable the probe in the next.
 */

/** Whether the runner preflight and the reset's submodule init run (#2179's gate). */
export function leanRunnerPreflightEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT !== "0";
}
