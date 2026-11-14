/**
 * lean/guard-fail-closed-switch — the ONE reader of the switch that decides whether
 * the publishable-branch guard refuses when it cannot resolve the mainline.
 *
 * `assertPublishableBranch` is the check that stands in front of every force-push the
 * lean driver makes, and its whole job is to compare the run's branch against the
 * mainline. When neither `git symbolic-ref` on the clone's own
 * `refs/remotes/origin/HEAD` nor `gh repo view` can name the mainline, the guard
 * used to return without an opinion and the push went ahead unchecked — a
 * force-push to `refs/heads/main` in the shape where the check was least likely to
 * run. The fail-closed arm asks origin instead (`git ls-remote --symref origin
 * HEAD`, over the transport the push itself will use) and, if origin will not say
 * either, refuses with the probe causes.
 *
 * `PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED=0` restores the old behaviour byte for byte:
 * an unresolvable mainline is a pass, no origin probe is made, and the push happens.
 * It exists for the operator whose origin is unreachable at the moment the step runs
 * and who has decided the push should go anyway — a judgement about their network,
 * not about the branch, and theirs to make rather than the guard's. Only the literal
 * `"0"` turns it off; unset and any other value leave it on.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file runs
 * in one bun process and pins off/on arms with `withEnv`, so a load-time read would
 * let one file's pin silently disable the rule in the next.
 */

/** Whether an unresolvable mainline refuses the push rather than passing it. */
export function leanGuardFailClosed(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_GUARD_FAIL_CLOSED !== "0";
}
