/**
 * forge-off — the ONE reader of `PI_ENSEMBLE_FORGE=none`.
 *
 * `none` is the operator's word for "there is no forge here": no detection, no
 * `gh`/`glab`, and every forge-backed site takes its no-forge path. It was read
 * at two sites that had to agree, and did not: `resolveCycleForge` short-circuits
 * it before detection, while `detectForge` treats only `github`/`gitlab` as a hard
 * override and reads anything else — `none` included — as "fall through to the
 * remote". Any site that went straight to `detectForge` therefore ran the parent's
 * CLI for a forge the operator had turned off.
 *
 * So the value is read here, once, and every consumer asks this predicate rather
 * than spelling the comparison. A second literal is a second reader that can
 * drift, which is the defect this module exists to prevent.
 *
 * The comparison is EXACT: `env.PI_ENSEMBLE_FORGE === "none"`, the raw value, no
 * trim and no case fold. That is what `resolveCycleForge` did before this module
 * existed, and the two are the same decision by construction rather than by
 * convention — so `None` or `"none "` is NOT off here, exactly as it was not off
 * there. `detectForge` folds case for its override values only; widening this
 * predicate would make a value the driver treats as a forge be off for the broker,
 * which is the disagreement in the other direction.
 *
 * The env is a parameter, defaulting to `process.env`, because the two consumers
 * do not consult the same copy: the driver resolves a cycle against an injected
 * bag (`resolveCycleForge`'s `opts.env`), while the broker answers in the parent
 * process and must see the parent's environment at request time. Callers pass a
 * bag or leave it out; nobody reads this at module load.
 */

/** Whether the operator turned the forge off for this environment. */
export function forgeEnvIsOff(env: Record<string, string | undefined> = process.env): boolean {
  return env.PI_ENSEMBLE_FORGE === "none";
}
