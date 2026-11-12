/**
 * lean/runner-preflight-switch — the ONE reader of the switch that decides whether a
 * lean run pays for the runner preflight and the reset's submodule re-initialisation.
 *
 * The switch gates two behaviours that arrived together and are shipped on by
 * default: `specify`'s probe of the project's own runner before the first dispatch,
 * and the `git submodule update --init --recursive` every lean reset runs after its
 * own `clean -fdx`. Both can end a run, and that is what an operator feels: a runner
 * that dies before collection, or a submodule whose source is gone, hands the run
 * back as infrastructure where the same run without the check is judged by the red
 * proof alone. A third thing is switched and it is only WORDING: the decline a child
 * that submitted nothing is reported under. The silence predicate and its single
 * retry are NOT switched, and `observeVerdict` is never switched — an observation
 * seam that reaches no outcome.
 *
 * Only the literal `"0"` turns it off; unset and any other value leave it on.
 *
 * The submodule gate sits inside `resetWorktreeToBase` rather than in its callers,
 * because the resets are made in six places and one gate there covers every lean
 * reset — `specify`'s, `build`'s fold, `challenge`'s and the review fix round's — not
 * only the callers that remembered to ask.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file runs in
 * one bun process and pins off/on arms with `withEnv`, so a load-time read would let
 * one file's pin silently disable the probe in the next.
 */

/** Whether the runner preflight and the reset's submodule init run. */
export function leanRunnerPreflightEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT !== "0";
}
