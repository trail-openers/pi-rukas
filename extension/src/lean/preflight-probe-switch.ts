/**
 * lean/preflight-probe-switch — the switch on the runner probe's containment, kept apart from
 * `runner-preflight-switch.ts` because the two answer different questions and must move apart: that one
 * decides whether the probe is RUN AT ALL (and with it the reset's submodule init); this one decides what
 * the probe's parent directory is CHECKED against, so an operator who finds the containment wrong can
 * restore the old path rules without losing the preflight.
 *
 * Before the probe is written, its parent directory is resolved with `realpath` and must lie inside
 * `realpath(worktree)`: the config cannot be trusted to name a directory that is really one of this
 * checkout. Off, the path is used as the config and fallback rules say, with the write still refusing a
 * link or non-file at the name. Only the literal `"0"` turns it off, read at CALL time.
 */

/** One environment's answer, as a parameter so a case pins it without touching `process.env`. */
function enabled(env: Record<string, string | undefined>, key: string): boolean {
  return env[key] !== "0";
}

/** Whether the probe's parent directory is containment-checked before the write. */
export function leanPreflightProbeContainEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return enabled(env, "PI_ENSEMBLE_LEAN_PREFLIGHT_PROBE_CONTAIN");
}
