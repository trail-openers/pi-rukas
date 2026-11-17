/**
 * lean/guard-fail-closed-switch — the ONE reader of the switch that decides whether the
 * publishable-branch guard refuses when it cannot resolve the mainline.
 *
 * `assertPublishableBranch` stands in front of every force-push the lean driver makes. When
 * neither `git symbolic-ref` nor `gh repo view` can name the mainline, the fail-closed arm asks
 * origin with `ORIGIN_PROBE_COMMAND` (`git ls-remote --symref origin HEAD`) — the same transport
 * the push it guards will use — and refuses when origin will not say either. Without the arm the
 * guard returns without an opinion and the push goes ahead unchecked. The probe is
 * `ORIGIN_PROBE_COMMAND` (`lean/publish-deps.ts`), issued through the harness's network-git wrapper.
 *
 * `PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED=0` restores the pass-through byte for byte: an unresolvable
 * mainline is a pass and no origin probe is made — for an operator whose origin is unreachable at
 * the moment the step runs, a judgement about their network, not the branch. Only the literal
 * `"0"` turns it off.
 *
 * Read at CALL time, not at module load: every lean smoke file runs in one bun process and pins
 * off/on arms with `withEnv`, so a load-time read would let one file's pin disable the next's.
 */

/** Whether an unresolvable mainline refuses the push rather than passing it. */
export function leanGuardFailClosed(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED !== "0";
}
