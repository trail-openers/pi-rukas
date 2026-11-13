#!/usr/bin/env bun
/**
 * forge-gl-grade — the GitLab job-state table behind `ci`'s row grading (#2224).
 *
 * The table exists because a GitLab job row has no `bucket` and its `status`
 * words are not gh's: a gate that matched them against gh's lists would silently
 * miss `created`, `waiting_for_resource`, `preparing` and `scheduled`, and a gate
 * that never matches is a gate that never fails. This suite pins each word to its
 * class, so the day a state is reclassified the drift is a red here rather than a
 * merge on a job that never ran.
 *
 * A state the table has never seen is graded `unknown`, which the callers WAIT on:
 * absence is never a pass, and that rule is the one this suite is mostly about.
 *
 *   (1) `success` is the ONLY passing state;
 *   (2) `failed`/`canceled` are red;
 *   (3) `running`/`created`/`scheduled`/`waiting_for_resource`/`preparing`/`pending`
 *       are pending, so they are waited and never read as a verdict;
 *   (4) `skipped`/`manual` are terminal but NOT green — the words that make a
 *       `rules:`/`only:` gate unable to fail a merge;
 *   (5) a word the table has never seen is `unknown`, never `pass`;
 *   (6) grading is case- and whitespace-tolerant, because the value is the forge's
 *       string and a forge that capitalises must not silently become `unknown`;
 *   (7) `allow_failure` is part of the grade, and it exempts ONLY the never-ran
 *       states: an allowed-to-fail `manual`/`skipped` is `pass` (GitLab does not
 *       count them against the pipeline, so a `manual` allow-failure deploy job
 *       must not turn a green pipeline red), while its `success` still passes,
 *       its `failed`/`canceled` stay RED and an unseen state stays `unknown` —
 *       an exemption that reached a row that ran would be a `.gitlab-ci.yml`
 *       switch for this gate, and one that reached a queued row would merge
 *       behind a job that has not reported. The flag is a REQUIRED argument
 *       precisely so a caller that never read it cannot silently assume the
 *       optimistic answer;
 *   (8) the caller the header names is still a caller: the adapter's job mapper
 *       reads `allow_failure` through this table, so the flag cannot quietly stop
 *       being carried and turn an exempt row back into a refusal.
 */

import { mapGlPipelineJobs } from "../src/forge-mapping.ts";
import {
  currentJobAttempts,
  glJobIsBlocking,
  gradeGlJobRow,
  gradeGlJobState,
} from "../src/forge-gl-grade.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── (1) `success` is the only pass ───────────────────────────────────────
assert(gradeGlJobState("success", true) === "pass", "(1) success passes");
for (const s of ["running", "created", "manual", "skipped", "failed", "canceled", ""]) {
  assert(gradeGlJobState(s, true) !== "pass", `(1) "${s}" is NOT a pass (${String(gradeGlJobState(s, true))})`);
}

// ── (2) the red states ───────────────────────────────────────────────────
for (const s of ["failed", "canceled"]) {
  assert(gradeGlJobState(s, true) === "fail", `(2) ${s} is a fail (${String(gradeGlJobState(s, true))})`);
}

// ── (3) the states that wait ─────────────────────────────────────────────
for (const s of [
  "running",
  "created",
  "scheduled",
  "waiting_for_resource",
  "preparing",
  "pending",
]) {
  assert(
    gradeGlJobState(s, true) === "pending",
    `(3) ${s} is pending, so it is waited (${String(gradeGlJobState(s, true))})`,
  );
}

// ── (4) terminal but never green ─────────────────────────────────────────
for (const s of ["skipped", "manual"]) {
  assert(
    gradeGlJobState(s, true) === "not-green",
    `(4) ${s} is terminal and NOT green (${String(gradeGlJobState(s, true))})`,
  );
}

// ── (5) an unseen word is never a pass ───────────────────────────────────
for (const s of ["succeeded", "ok", "done", "passed", "???"]) {
  assert(
    gradeGlJobState(s, true) === "unknown",
    `(5) "${s}" is unknown, waited rather than passed (${String(gradeGlJobState(s, true))})`,
  );
}
// Absence says nothing, and nothing is not a pass: the caller must WAIT, and an
// expired wait hands the run back rather than merging on a blank.
for (const s of ["", "   ", "\t"]) {
  const g = gradeGlJobState(s, true);
  assert(
    g === "unknown" || g === "pending",
    `(5) a blank state "${s}" is never passed (${String(g)})`,
  );
}

// ── (6) the forge's own capitalisation still grades ──────────────────────
for (const [raw, want] of [
  ["SUCCESS", "pass"],
  ["  success  ", "pass"],
  ["Failed", "fail"],
  ["Skipped", "not-green"],
] as const) {
  assert(
    gradeGlJobState(raw, true) === want,
    `(6) "${raw}" grades ${want} (${String(gradeGlJobState(raw, true))})`,
  );
}

// ── (7) `allow_failure` exempts the never-ran states, and only those ──────
// GitLab does not count a job the pipeline is allowed to fail against the
// pipeline, and its commit-status machine calls such a pipeline `success`. So a
// `manual` or `skipped` row carrying `allow_failure: true` is a pass here: it is
// a job the pipeline never intended to run, which is what a typical GitLab
// pipeline with a human-triggered deploy job looks like, and refusing on it was
// the false red this ruling removes. What the exemption does NOT reach is the
// point of the whole section: a row that ran and said something negative stays
// RED, and a state this table has never seen stays `unknown`. An exemption that
// read either of those as green would hand anyone who can edit `.gitlab-ci.yml`
// a switch for the gate that reads this table.
for (const s of ["manual", "skipped"]) {
  assert(
    gradeGlJobState(s, false) === "pass",
    `(7) an allow-failure ${s} is exempt, not a refusal (${String(gradeGlJobState(s, false))})`,
  );
}
assert(
  gradeGlJobState("success", false) === "pass",
  `(7) an allow-failure success still passes (${String(gradeGlJobState("success", false))})`,
);
for (const s of ["failed", "canceled"]) {
  assert(
    gradeGlJobState(s, false) === "fail",
    `(7) an allow-failure ${s} stays RED — allow_failure is not a switch for the gate (${String(gradeGlJobState(s, false))})`,
  );
}
for (const s of ["running", "pending", "created", "scheduled"]) {
  assert(
    gradeGlJobState(s, false) === "pending",
    `(7) an allow-failure ${s} still waits — "will run" is not "may be skipped" (${String(gradeGlJobState(s, false))})`,
  );
}
for (const s of ["succeeded", "ok", "???"]) {
  assert(
    gradeGlJobState(s, false) === "unknown",
    `(7) an allow-failure row in an unseen state is unknown, never passed (${String(gradeGlJobState(s, false))})`,
  );
}
// The reading of the raw field itself: GitLab sends booleans, an absent field is
// its own default (blocking), and a string `"true"` from an odd instance must not
// make a non-gate into a gate.
assert(glJobIsBlocking(undefined) === true, "(7) absent allow_failure means blocking");
assert(glJobIsBlocking(false) === true, "(7) allow_failure false means blocking");
assert(glJobIsBlocking(true) === false, "(7) allow_failure true means NOT blocking");
assert(glJobIsBlocking("true") === false, "(7) a string \"true\" is read as allow_failure");
assert(glJobIsBlocking("false") === true, "(7) a string \"false\" is read as blocking");

// ── (8) the callers that DO consult the table still consult it ───────────
// The header names the callers, and a header that outlives its callers is how
// this module once came to advertise a merge-evidence gate that never imported
// it. These assertions are the witnesses for that claim rather than prose: the
// adapter's mapper is what turns GitLab's raw `allow_failure` into the `blocking`
// flag the table grades, and if the mapper stopped calling it then an exempt row
// would reach the step as an ordinary blocking row and be refused — the mirror
// image of the defect the flag exists to remove. `ci`'s own row grading is
// exercised end-to-end by `test-lean-ci-gl.ts`, the merge gate's by
// `test-merge-guard-ci-evidence-gitlab.ts`.
const mapped = mapGlPipelineJobs([{ name: "optional", status: "success", allow_failure: true }]);
assert(
  mapped.length === 1 && mapped[0]?.blocking === false,
  `(8) the adapter carries allow_failure into the table's blocking flag (${JSON.stringify(mapped[0])})`,
);
assert(
  gradeGlJobState(mapped[0]?.state ?? "", mapped[0]?.blocking ?? true) === "pass",
  "(8) and a mapped allow-failure success passes end-to-end",
);
// The row form, which is what the merge gate grades: it reads the raw
// `allow_failure` field through `glJobIsBlocking` itself, so a raw API row and an
// adapter-mapped row must not disagree about the same job.
assert(
  gradeGlJobRow({ name: "deploy", status: "manual", allow_failure: true }) === "pass",
  "(8) a raw allow-failure manual ROW passes (the merge gate's shape)",
);
assert(
  gradeGlJobRow({ name: "deploy", status: "manual" }) === "not-green",
  "(8) a manual row that did not answer allow_failure is still refused",
);
assert(
  gradeGlJobRow(null as unknown as Record<string, unknown>) === "unknown",
  "(8) a row that is not an object is refused, not thrown on",
);
assert(
  gradeGlJobState("SUCCESS", glJobIsBlocking(undefined)) === "pass",
  "(8) and a mapped row with no allow_failure field still passes",
);

// ── (9) the retry rule: one row per job NAME, and a red survives it ──────
// `/pipelines/:id/jobs` is a job HISTORY. The endpoint keeps every superseded
// attempt, so grading the raw rows refuses a pipeline the forge itself calls
// green. The collapse keeps the highest id per name — but only where the higher
// row is a verdict: see `currentJobAttempts`' header for the three rules.
{
  const retried = currentJobAttempts([
    { name: "test", id: 1, status: "failed", allow_failure: false },
    { name: "test", id: 2, status: "success", allow_failure: false },
  ]);
  assert(
    retried.length === 1 && gradeGlJobRow(retried[0] as Record<string, unknown>) === "pass",
    `(9) a retried job is ONE row, the retry's verdict (${JSON.stringify(retried)})`,
  );
}
{
  // The direction this rule exists to block: an exempt row (which grades `pass`
  // without a job having run) may not take the seat of a row that FAILED.
  const notARetry = currentJobAttempts([
    { name: "test", id: 1, status: "failed", allow_failure: false },
    { name: "test", id: 2, status: "manual", allow_failure: true },
  ]);
  assert(
    gradeGlJobRow(notARetry[0] as Record<string, unknown>) === "fail",
    `(9) a never-ran allow-failure row cannot retire a failure (${JSON.stringify(notARetry)})`,
  );
}
{
  const queued = currentJobAttempts([
    { name: "test", id: 1, status: "failed", allow_failure: false },
    { name: "test", id: 2, status: "running", allow_failure: false },
  ]);
  assert(
    gradeGlJobRow(queued[0] as Record<string, unknown>) === "pending",
    `(9) a retry still queued keeps the seat and is waited, not passed (${JSON.stringify(queued)})`,
  );
}

process.exit(exit);
