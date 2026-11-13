/**
 * lean/verified-handback-switch — the ONE reader of the switch that decides
 * whether a handback ships the last verified head.
 *
 * A handback whose newest work step is a `fixed` review leaves origin holding
 * bytes no `verify` ever certified. With the switch on the step moves origin's
 * branch back to the newest decided green before it reports, and records which
 * head shipped; with it off the step reports and moves nothing, exactly as it
 * did before the rule. Only the literal `"0"` turns it off; unset and any other
 * value leave it on.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file
 * runs in one bun process and pins off/on arms with `withEnv`, so a load-time
 * read would let one file's pin silently disable the rule in the next.
 */

/** Whether a handback rewinds origin to the last verified head. */
export function leanVerifiedHandbackEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_VERIFIED_HANDBACK !== "0";
}
