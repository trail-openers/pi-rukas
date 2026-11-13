/**
 * forge-gl-grade — the ONE table that says what a GitLab job state means.
 *
 * GitLab pipeline jobs carry only a `status` string (uppercase by the time the
 * adapter's mapper has finished with them) and no `bucket`, so a caller that
 * grades rows the GitHub way — `bucket ?? state` against gh's pass/fail/pending
 * words — silently misses `created`, `waiting_for_resource`, `preparing` and
 * `scheduled`, and a gate that never matches is a gate that never fails. This
 * is the ONE table for those words: every caller that asks what a GitLab job
 * state means asks here, and the callers that do — lean's `ci` step (via
 * `glRowGrade`), the adapter's job mapper (via `glJobIsBlocking`) and the
 * driver's GitLab merge evidence (via `gradeGlJobRow` and
 * {@link currentJobAttempts}) — are reached through this file rather than
 * carrying their own word lists.
 *
 * That unity is deliberate and it is what makes the allow-failure rule below
 * load-bearing twice: the same table decides whether `ci` waits on a pipeline
 * and whether the land gate lets a commit through, so a job the pipeline is
 * allowed to fail cannot mean one thing to the poll and another to the merge.
 *
 * The allow-failure axis belongs to this table rather than to each caller, and
 * it exempts exactly the states GitLab itself does not count against the
 * pipeline — `manual` and `skipped`, the two a pipeline carries without ever
 * running them. GitLab's own commit-status machine calls such a pipeline
 * `success`, so a gate that refused on those refused MRs the forge reports as
 * green, and an `allow_failure: true` deploy job left for a human turned a
 * typical GitLab pipeline red in `ci` and unparkable at `land`. What is NOT
 * exempt is worth naming as precisely: `failed` and `canceled` stay `fail` and
 * unknown states stay `unknown` whatever `allow_failure` says, because a job
 * that ran said something about this code, and an exemption that reached them
 * would hand anyone who can edit `.gitlab-ci.yml` a switch for this gate. A
 * `pending` row is not exempt either — "will run" is not "may be skipped", and
 * a gate that read a queued job as green would be merging behind a job that has
 * not reported yet.
 *
 * The five grades:
 *   - `pass`      — a `success` on a blocking job, or a `manual`/`skipped` on a
 *                   job the pipeline is allowed to fail (see above);
 *   - `fail`      — `failed`, `canceled`: a red verdict, blocking or not;
 *   - `pending`   — still working: `running`, `pending`, `created`,
 *                   `waiting_for_resource`, `waiting_for_callback`, `preparing`,
 *                   `scheduled`, `canceling`. Waited on, never graded red and
 *                   never graded green;
 *   - `not-green` — `skipped` or `manual` on a job that IS blocking: terminal,
 *                   and NOT evidence of a pass. A job that was skipped by an
 *                   `only:`/`rules:` gate or left for a human to trigger, and
 *                   that the pipeline holds itself to, is a gate that did not
 *                   decide anything — the same "a gate that cannot fail" defect
 *                   GitHub's `skipped`/`neutral` rows are refused for;
 *   - `unknown`   — anything else, including the empty string. A state this
 *                   table has never seen waits rather than passing: the caller
 *                   bounds its wait and hands the run back, and a server-side
 *                   enum addition never becomes a green by omission.
 *
 * Comparison is case- and whitespace-insensitive because callers read the value
 * from different places (the adapter uppercases, the raw API does not), and
 * every caller reads `allow_failure` through `glJobIsBlocking` — GitLab sends
 * `true`/`false`, an absent field means GitLab's own default, and a caller that
 * never looked at the field must not silently assume the optimistic one.
 */

/** One GitLab job state's grade. */
export type GlJobGrade = "pass" | "fail" | "pending" | "not-green" | "unknown";

/** The one state that is green on a blocking job. */
const GL_PASS: ReadonlySet<string> = new Set(["success"]);

/** The states that are a red verdict, blocking or not. */
const GL_FAIL: ReadonlySet<string> = new Set(["failed", "canceled"]);

/**
 * The states that mean "still working" — waited on, never judged.
 *
 * `waiting_for_callback` and `canceling` are here alongside the six the GitLab
 * job API documents as in-flight: both are transient and neither has said
 * anything about the code, and a state that waits is always recoverable where a
 * state that passes is not.
 */
const GL_PENDING: ReadonlySet<string> = new Set([
  "running",
  "pending",
  "created",
  "waiting_for_resource",
  "waiting_for_callback",
  "preparing",
  "scheduled",
  "canceling",
]);

/**
 * Terminal states that are NOT a pass on a blocking job (see the module header).
 *
 * For a job the pipeline is allowed to fail these are the exempt states: GitLab
 * does not count them against the pipeline, so this table grades them `pass`.
 */
const GL_NOT_GREEN: ReadonlySet<string> = new Set(["skipped", "manual"]);

/** The states in which a job EXECUTED — everything else never ran. */
const GL_EXECUTED: ReadonlySet<string> = new Set(["success", "failed", "canceled"]);

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
 * `blocking` is the job's blocking-ness from {@link glJobIsBlocking}. A job the
 * pipeline is allowed to fail is not a gate, so `manual` and `skipped` are
 * `pass` (GitLab's commit-status machine reports such a pipeline green, and a
 * `manual` deploy job marked `allow_failure: true` inside a passing pipeline is
 * a normal GitLab configuration, not a hole in this one). The exemption stops
 * there: `failed` and `canceled` stay `fail` and an unrecognised state stays
 * `unknown` (see the module header for why an exemption that reached them would
 * be a switch for the gate). The parameter is deliberately REQUIRED: a caller
 * whose row shape never carried `allow_failure` must decide what that absence
 * means rather than inherit an optimistic default.
 */
export function gradeGlJobState(state: string, blocking: boolean): GlJobGrade {
  const v = state.toLowerCase().trim();
  if (!blocking) {
    // Exempt only the never-ran states, and read them before the blocking arms
    // so an allow-failure `manual` cannot fall through to `not-green`.
    if (GL_NOT_GREEN.has(v)) return "pass";
  }
  if (GL_PASS.has(v)) return "pass";
  if (GL_FAIL.has(v)) return "fail";
  if (GL_PENDING.has(v)) return "pending";
  if (GL_NOT_GREEN.has(v)) return "not-green";
  return "unknown";
}

/**
 * Grade one job ROW — the row's `status` and its `allow_failure` field, read
 * through {@link glJobIsBlocking} so a caller that hands over a raw API row
 * gets the same answer as one that hands over the adapter's normalized shape.
 *
 * Kept for the row-by-row caller. The merge-evidence gate grades the CURRENT
 * attempt of each job, not every row the endpoint ever returned — see
 * {@link currentJobAttempts}, which is where the retry rule lives.
 *
 * A row that is not an object (`null` is the shape a partially-decoded payload
 * leaves behind) has no `status` to read, and a row with no status is a state
 * nobody graded: `unknown`, which every caller already refuses on. Reading
 * `.status` off such a row throws instead, and an exception that escapes the
 * gatherer is not a refusal — the caller never receives a verdict at all.
 */
/** Whether a row's own `status` names a job that EXECUTED — everything else never ran.
 * Exported for the merge-evidence gate's at-least-one-ran rule, so the two readers
 * of that word list cannot drift apart. */
export function jobRowExecuted(row: unknown): boolean {
  const status = (row as { status?: unknown } | null)?.status;
  return typeof status === "string" && GL_EXECUTED.has(status.toLowerCase());
}

export function gradeGlJobRow(row: Record<string, unknown>): GlJobGrade {
  const fields = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
  const status = typeof fields.status === "string" ? fields.status : "";
  return gradeGlJobState(status, glJobIsBlocking(fields.allow_failure));
}

/** Whether a row is a retry still queued — an absence of verdict, not a pass. */
function rowIsPending(row: unknown): boolean {
  return gradeGlJobRow(row as Record<string, unknown>) === "pending";
}

/**
 * The rows a merge decision may be drawn from: one row per job NAME, the one
 * GitLab considers current. A row that is not an object is NOT dropped — it
 * survives the collapse and reaches the grade table as `unknown`, which the
 * gatherer refuses on (see the third rule below).
 *
 * `/pipelines/:id/jobs` is a job HISTORY, not a job list. A retried job leaves
 * its superseded row in the response at its own terminal state (GitLab's own
 * pipeline view shows one job with a retry arrow, because it reads the highest
 * id per name), so grading the raw rows reports the failure that was already
 * retried away: `required checks failing: test` on a pipeline the forge itself
 * calls green. Directionally that is fail-closed — it can refuse a green MR but
 * never pass a red one — which is exactly why it needs its own rule rather than
 * being noticed as a false green.
 *
 * Tie-break is `id`, highest wins: GitLab's job ids are monotonic, so the
 * greatest id for a name is its latest attempt. A row without a numeric id (a
 * partial payload, an older API) is kept as the sole candidate for its name and
 * is NOT dropped — dropping it would make "no rows" look like an empty pipeline
 * and refuse on the absence of evidence, and a named row is evidence, however
 * imperfectly ordered. When a name has both id-bearing and id-less rows, the
 * highest id wins and the id-less row is ignored.
 *
 * Three rules narrow that tie-break, all for the same reason — the collapse must
 * never be the way a red row disappears:
 *
 *   - A row with no name, or one that is not an object at all, gets its OWN key
 *     rather than the one shared `""` slot. Rows the endpoint did not name are
 *     not one job, and filing them as one lets an allow-failure `manual` row
 *     (which grades `pass`) displace a nameless `failed` row and report a red
 *     pipeline green — a false green, the direction this rule exists to block.
 *     The same reasoning narrows the tie-break for those rows only: a row the
 *     forge gave no name to has never claimed to be another attempt of anything,
 *     so it may not take the seat of a row that FAILED. Named rows keep the id
 *     rule untouched, because there the higher id IS GitLab's own statement that
 *     this is the retry.
 *   - A row that is not an object SURVIVES the collapse rather than being
 *     dropped, and reaches the grade table as `unknown`, which the gatherer
 *     refuses on. Dropping it would turn "the endpoint answered something odd"
 *     into "this pipeline has no jobs", which is the absence-of-evidence refusal
 *     for a pipeline that did answer.
 *   - A named row may take the seat of an older FAILED row of the same name only
 *     if it EXECUTED — `success`, `failed`, `canceled` — or is still `pending`.
 *     The higher id is GitLab's statement that this row is the retry of that one,
 *     and a row that never ran has not retried anything: a `manual` or `skipped`
 *     row grades `pass` only when allowed to fail, without a job having run, so
 *     letting it take the seat retires a red run on the strength of a button
 *     nobody pressed. A genuine retry (a failed row, then a newer `success`) is
 *     a row that ran, so it keeps the seat and the pipeline goes green; a retry
 *     still queued keeps the seat too, and the gatherer refuses on it as pending.
 */
export function currentJobAttempts(rows: unknown[]): unknown[] {
  const best = new Map<string, { row: unknown; id: number | undefined }>();
  let anonymous = 0;
  for (const row of rows) {
    const objectRow = typeof row === "object" && row !== null;
    const r = (objectRow ? row : {}) as Record<string, unknown>;
    const named = typeof r.name === "string" && r.name !== "";
    // Each row the endpoint did not name is its own job as far as this collapse
    // is concerned — never a competitor for one shared nameless seat.
    const name = named ? (r.name as string) : `\u0000anon:${anonymous++}`;
    const id = typeof r.id === "number" && Number.isFinite(r.id) ? r.id : undefined;
    const seen = best.get(name);
    if (seen === undefined) {
      best.set(name, { row, id });
      continue;
    }
    // A name whose attempts disagree on order is decided by id; a row with no id
    // never displaces one that has it, and never displaces another without one
    // (first seen keeps the seat, so the answer is stable across runs).
    if (id === undefined || (seen.id !== undefined && id <= seen.id)) continue;
    if (gradeGlJobRow(seen.row as Record<string, unknown>) === "fail") {
      // The seat is being taken from a row that failed, so the replacement has
      // to be a verdict: an unnameable row never claimed to be the retry of
      // anything (see the header), and a row that never ran has not retried the
      // failure it would otherwise erase. A queued retry is let through — it
      // keeps the seat, and the gatherer refuses on it as pending, which is the
      // same answer the retained failure would have given.
      if (!named) continue;
      if (!jobRowExecuted(r) && !rowIsPending(r)) continue;
    }
    best.set(name, { row, id });
  }
  return [...best.values()].map((b) => b.row);
}
