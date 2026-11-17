/**
 * gl-mr-create-switch — the ONE reader of the switch that decides how the
 * adapter builds `glab mr create`.
 *
 * The builder that shipped emitted `glab mr create <branch> … --description-file
 * <file> … --output json`: a positional source branch, a description-file flag
 * and an output-format flag. Neither the positional source nor `--output` is a
 * flag that subcommand has on any version (verified on 1.130.0, which answers a
 * bare branch with `unknown command` and `--output` with `unknown flag`), so the
 * create was refused either way; `--description-file` itself exists from 1.115.0
 * and is refused on older builds, which is why the fixed command uses the inline
 * `-d` that every version lists. Every GitLab PR-create step died on
 * `ERROR Unknown flag:` before any network call, and the plain URL a real create
 * prints on success was never read, because the mapper parsed stdout as JSON.
 *
 * On (the default) the create is built as argv of flags the subcommand actually
 * lists, with the body as one argv element. `"0"` puts the pre-fix shell string
 * back byte for byte — including its invented flags — for an operator whose
 * cycle needs to be compared against the known-broken baseline while a GitLab
 * fix is under review. Only the literal `"0"` turns it off; unset and any other
 * value leave it on.
 *
 * The env var is read at CALL time, not at module load: the smoke tests pin both
 * arms in one bun process, and a load-time read would report the first value for
 * both and let the suite agree with itself.
 */

/** Whether `glab mr create` is built on the argv path (`true`) or the pre-fix shell string (`false`). */
export function glabMrCreateArgvEnabled(): boolean {
  return process.env.PI_ENSEMBLE_GLAB_MR_CREATE !== "0";
}
