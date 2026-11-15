/**
 * lens-large-diff-switch — the ONE reader of the switch that governs how a large
 * review diff is read and how it reaches the lens children (#2261).
 *
 * Two limits used to be the whole story. The tool-side range read ran under a
 * 1 MiB `maxBuffer`, and the lens prompt inlined whatever diff it produced
 * verbatim. Each failed the same way and neither said so: a 130-file branch died
 * in six lenses at `exit 1` inside 250 ms (the read overflowed on the ERROR
 * object, with an empty stderr, so the stderr-only classifier never saw it); a
 * ~800 KB delta inlined into six prompts died at the provider with HTTP 400
 * "maximum context length" and was reported as infrastructure.
 *
 * With the switch on, the size-sensitive reads share one ceiling and the lens
 * prompt is bounded by the existing diff-cap helper, so a large diff reaches the
 * lenses and an over-ceiling one fails with a reason that names the limit. With
 * it off the layer reads the 1 MiB `DIFF_MAX_BUFFER` and inlines the whole diff,
 * exactly as it did before — the arm exists so an operator who wants the old
 * shape gets it verbatim rather than a near-miss of it.
 *
 * Only the literal `"0"` turns the fixed behaviour off. Unset and any other
 * value leave it on, because the pre-fix shape is the failure this exists to
 * close and an unset variable must not quietly restore it.
 *
 * The env var is read at CALL time, not at module load: the offline smoke files
 * run in one bun process each and pin the off/on arms with `withEnv`, so a
 * load-time read would let one file's pin disable the rule in the next.
 */

/** Whether the large-diff reads and the bounded lens prompt are in force. */
export function lensLargeDiffEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LENS_LARGE_DIFF !== "0";
}
