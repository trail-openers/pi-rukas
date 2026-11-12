/**
 * forge-gl-grade — the ONE table that says what a GitLab job state means.
 *
 * GitLab pipeline jobs carry only a `status` string (uppercase by the time the
 * adapter's mapper has finished with them) and no `bucket`, so a caller that
 * grades rows the GitHub way — `bucket ?? state` against gh's pass/fail/pending
 * words — silently misses `created`, `waiting_for_resource`, `preparing` and
 * `scheduled`, and a gate that never matches is a gate that never fails. This
 * is the ONE table for those words: every caller that asks what a GitLab job
 * state means asks here, and the two that do — lean's `ci` step (via
 * `glRowGrade`) and the adapter's job mapper (via `glJobIsBlocking`) — are
 * reached through this file rather than carrying their own word lists.
 *
 * What is NOT a caller is worth naming, because the module reads as a shared
 * gate otherwise: `gatherMergeEvidence` and the merge guard grade `gh` bucket
 * words on a GitHub-only path (`refuseUnlessCiGreen` returns early for any
 * other forge), so they do not consult this table and their lists are not
 * kept in step with it by anything here — which is OUT OF SCOPE of #2224, whose
 * remit is the `ci` step reading GitLab through the forge adapter. Nothing in
 * this file stops a future caller from growing a second list; the guarantee it
 * does give is that no current GitLab read has one.
 *
 * A job's `allow_failure` flag is part of the grade, not a footnote: GitLab
 * reports a job that is allowed to fail as `success` once it finishes, so the
 * word alone cannot tell a gate that ran from a gate that could not have failed
 * the pipeline. `blocking` says which job the caller means, and a caller that
 * never read the field gets the safe assumption — see {@link gradeGlJobState}.
 *
 * The five grades:
 *   - `pass`      — `success` AND a blocking job; the only green;
 *   - `fail`      — `failed`, `canceled`: a red verdict;
 *   - `pending`   — still working: `running`, `pending`, `created`,
 *                   `waiting_for_resource`, `preparing`, `scheduled`. Waited on,
 *                   never graded red and never graded green;
 *   - `not-green` — `skipped`, `manual`, or a `success` on a job that is not
 *                   blocking: terminal, and NOT evidence of a pass. A job that
 *                   was skipped by an `only:`/`rules:` gate, left for a human to
 *                   trigger, or marked `allow_failure: true` is a gate that did
 *                   not decide anything, which is the same "a gate that cannot
 *                   fail" defect GitHub's `skipped`/`neutral` rows are refused
 *                   for;
 *   - `unknown`   — anything else, including the empty string. A state this
 *                   table has never seen waits rather than passing: the caller
 *                   bounds its wait and hands the run back, and a server-side
 *                   enum addition never becomes a green by omission.
 *
 * Comparison is case- and whitespace-insensitive because callers read the value
 * from different places (the adapter uppercases, the raw API does not), and
 * every caller reads `allow_failure` through `glJobIsBlocking` — GitLab
 * sends `true`/`false`, an absent field means GitLab's own default, and a caller
 * that never looked at the field must not silently assume the optimistic one.
 */

/** One GitLab job state's grade. */
export type GlJobGrade = "pass" | "fail" | "pending" | "not-green" | "unknown";

/** The one state that is green. */
const GL_PASS: ReadonlySet<string> = new Set(["success"]);

/** The states that are a red verdict. */
const GL_FAIL: ReadonlySet<string> = new Set(["failed", "canceled"]);

/** The states that mean "still working" — waited on, never judged. */
const GL_PENDING: ReadonlySet<string> = new Set([
  "running",
  "pending",
  "created",
  "waiting_for_resource",
  "preparing",
  "scheduled",
]);

/** Terminal states that are NOT a pass (see the module header). */
const GL_NOT_GREEN: ReadonlySet<string> = new Set(["skipped", "manual"]);

/**
 * One GitLab job's blocking-ness, read from its raw `allow_failure` field.
 * GitLab's own default is `false` (the job IS blocking), so absent means
 * blocking; a non-boolean is read as its lowercase text, so an instance that
 * sends `"true"` cannot turn a job that is allowed to fail into a gate.
 */
export function glJobIsBlocking(allowFailure: unknown): boolean {
  if (typeof allowFailure === "boolean") return !allowFailure;
  if (typeof allowFailure === "string") return allowFailure.trim().toLowerCase() !== "true";
  return true;
}

/**
 * Grade one GitLab job against the shared table.
 *
 * `blocking` is the job's blocking-ness from {@link glJobIsBlocking}: a job that
 * is allowed to fail is not a gate, so its `success` is `not-green` (the same
 * answer as a `skipped` job — a gate that could not have failed the pipeline
 * decided nothing) and its `failed` is `unknown`, waited rather than red. The
 * parameter is deliberately REQUIRED: a caller whose row shape never carried
 * `allow_failure` must decide what that absence means rather than inherit an
 * optimistic default, which is how a `success` that could not fail came to read
 * as green here.
 */
export function gradeGlJobState(state: string, blocking: boolean): GlJobGrade {
  const v = state.toLowerCase().trim();
  if (!blocking) {
    if (GL_PASS.has(v) || GL_NOT_GREEN.has(v)) return "not-green";
    // A failure that cannot fail the pipeline is not a verdict about the code;
    // it waits, and an expired wait hands the run back rather than blaming it.
    if (GL_FAIL.has(v)) return "unknown";
  }
  if (GL_PASS.has(v)) return "pass";
  if (GL_FAIL.has(v)) return "fail";
  if (GL_PENDING.has(v)) return "pending";
  if (GL_NOT_GREEN.has(v)) return "not-green";
  return "unknown";
}
