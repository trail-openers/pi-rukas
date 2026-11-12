/**
 * forge-gl-grade — the ONE table that says what a GitLab job state means.
 *
 * GitLab pipeline jobs carry only a `status` string (uppercase by the time the
 * adapter's mapper has finished with them) and no `bucket`, so a caller that
 * grades rows the GitHub way — `bucket ?? state` against gh's pass/fail/pending
 * words — silently misses `created`, `waiting_for_resource`, `preparing` and
 * `scheduled`, and a gate that never matches is a gate that never fails. This
 * table is the answer both callers share: lean's `ci` step refuses to read a
 * pipeline green without it, and the merge-evidence gatherer refuses to merge
 * without the same words. Two lists that can drift about whether `skipped` is
 * green is exactly the defect class this file removes.
 *
 * The five grades:
 *   - `pass`      — `success`; the only state that counts as green;
 *   - `fail`      — `failed`, `canceled`: a red verdict;
 *   - `pending`   — still working: `running`, `pending`, `created`,
 *                   `waiting_for_resource`, `preparing`, `scheduled`. Waited on,
 *                   never graded red and never graded green;
 *   - `not-green` — `skipped`, `manual`: terminal, and NOT evidence of a pass.
 *                   A job that was skipped by a `only:`/`rules:` gate, or left
 *                   for a human to trigger, is a gate that did not run, which is
 *                   the same "a gate that cannot fail" defect GitHub's
 *                   `skipped`/`neutral` rows are refused for;
 *   - `unknown`   — anything else, including the empty string. A state this
 *                   table has never seen waits rather than passing: the caller
 *                   bounds its wait and hands the run back, and a server-side
 *                   enum addition never becomes a green by omission.
 *
 * Comparison is case- and whitespace-insensitive because the two callers read
 * the value from different places (the adapter uppercases, the raw API does not).
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

/** Grade one GitLab job status against the shared table. */
export function gradeGlJobState(state: string): GlJobGrade {
  const v = state.toLowerCase().trim();
  if (GL_PASS.has(v)) return "pass";
  if (GL_FAIL.has(v)) return "fail";
  if (GL_PENDING.has(v)) return "pending";
  if (GL_NOT_GREEN.has(v)) return "not-green";
  return "unknown";
}
