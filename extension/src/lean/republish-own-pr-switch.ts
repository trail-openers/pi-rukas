/**
 * lean/republish-own-pr-switch — the ONE reader of the switch that decides whether
 * `lean/publish` may push again to the PR this run itself opened.
 *
 * A red `ci` sends the run back through `build` and `verify` and into `publish`
 * again, and by then origin's branch holds the sha the run's own last publish wrote
 * and the forge holds the PR that publish created. `pushLeaseTarget` reads origin,
 * sees a sha that is neither absent nor this head, asks the forge for the branch's
 * open PRs and refuses on the FIRST row whose state is not positively CLOSED/MERGED
 * — so the run's own PR is the thing that refuses the run, every time, and the
 * ci-red → build → publish loop always ends `handed-back` at exit 10.
 *
 * With the knob on, that one row may be read rather than assumed: the step exempts
 * it when origin still holds exactly the `publishedHead` the run's newest DECIDED
 * publish recorded, that sha is an ancestor of the head about to be pushed, and the
 * single unsettled row is byte-for-byte the `prUrl` that same record names AND the
 * row `openPr` goes on to reuse. The push still carries `--force-with-lease` bound
 * to the origin sha read before the forge was asked, and the forge list is still
 * asked — the identity is read, never assumed.
 *
 * `PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR=0` puts today's refusal back exactly: origin
 * differing from head over any unsettled row is a handback, whatever the row is.
 * Only the literal `"0"` turns the exemption off.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file runs
 * in one bun process and pins arms with `withEnv`, so a load-time read would let one
 * file's pin disarm the rule in the next.
 */

/** Whether publish may re-push to the PR this run's own record names. */
export function leanRepublishOwnPrEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_REPUBLISH_OWN_PR !== "0";
}
