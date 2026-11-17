/**
 * lean/preflight-probe-switch — the two switches on the runner probe's SHAPE,
 * kept apart from `runner-preflight-switch.ts` because they answer different
 * questions and must be able to move apart: that one decides whether the probe
 * is RUN AT ALL (and with it the reset's submodule init); the two here decide
 * what the probe LOOKS LIKE and what one of its answers MEANS, so an operator
 * who finds the new probe name or the new exit-4 reading wrong can put the old
 * behaviour back without losing the preflight.
 *
 *   - COLLECTABLE — for a project whose `verify.testGlob` names `.py` files the probe is a
 *     visible, dot-free `_lean_runner_probe.py` inside the configured `verify.testDir`, and exit
 *     4 on the probe reads as "the runner rejected the probe file", not as a runner that cannot
 *     run tests. A hidden dotfile cannot be IMPORTED, so pytest's default prepend import mode
 *     dies on the leading dot; and exit 4 is pytest's "no such file / no collector", a fact
 *     about the probe rather than the bench. Off, the probe keeps its hidden root-level name and
 *     every non-0/5 status hand-backs.
 *   - CONTAIN — before the probe is written, its parent directory is resolved with `realpath`
 *     and must lie inside `realpath(worktree)`; the config cannot be trusted to name a directory
 *     that is really a directory of this checkout. Off, the path is used as the config and the
 *     fallback rule say, with the write itself still refusing a link or a non-file at the name.
 *
 * Only the literal `"0"` turns either off; unset and any other value leave it on. Both are read
 * at CALL time, not at module load: every lean smoke file runs in one bun process and pins
 * off/on arms with `withEnv`, so a load-time read would let one file's pin disable the other's.
 */

/**
 * The switch's answer for one environment. A parameter rather than `process.env`
 * because a case that pins the ambient value leaks into whichever case runs after
 * it — the two files then disagree about the default depending on order.
 */
function enabled(env: Record<string, string | undefined>, key: string): boolean {
  return env[key] !== "0";
}

/** Whether the collectable probe name and the exit-4 "probe rejected" reading run. */
export function leanPreflightProbeCollectableEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return enabled(env, "PI_ENSEMBLE_LEAN_PREFLIGHT_PROBE_COLLECTABLE");
}

/** Whether the probe's parent directory is containment-checked before the write. */
export function leanPreflightProbeContainEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return enabled(env, "PI_ENSEMBLE_LEAN_PREFLIGHT_PROBE_CONTAIN");
}
