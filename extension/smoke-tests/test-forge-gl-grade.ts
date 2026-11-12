#!/usr/bin/env bun
/**
 * forge-gl-grade — the GitLab job-state table the `ci` step and the merge-evidence
 * gate share (#2224).
 *
 * The table exists because two gates grade the same words — `ci`'s row grading and
 * the driver's merge-evidence gate — and a `skipped` job that one side counts as
 * green is a gate that cannot fail. This suite pins each word to its class, so the
 * day either gate grows a state the other has never seen, the drift is a red here
 * rather than a merge on a job that never ran.
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
 *   (7) `allow_failure` is part of the grade: a job that is allowed to fail is
 *       not a gate, so its `success` reads `not-green` and its `failed` is waited
 *       rather than red — and the flag is a REQUIRED argument precisely so a
 *       caller that never read it cannot silently assume the optimistic answer.
 */

import { glJobIsBlocking, gradeGlJobState } from "../src/forge-gl-grade.ts";

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

// ── (7) `allow_failure` decides whether a `success` is a green ────────────
// GitLab reports a job that is allowed to fail as `success` once it finishes, so
// the word alone cannot separate a gate that ran from a gate that could not have
// failed the pipeline. A non-blocking job therefore never passes: its `success`
// joins `skipped`/`manual` as `not-green`, and its `failed` is waited rather than
// spent as a red on code that cannot have failed anything.
assert(
  gradeGlJobState("success", false) === "not-green",
  `(7) a non-blocking success is NOT green (${String(gradeGlJobState("success", false))})`,
);
assert(
  gradeGlJobState("failed", false) === "unknown",
  `(7) a non-blocking failure is waited, not red (${String(gradeGlJobState("failed", false))})`,
);
assert(
  gradeGlJobState("running", false) === "pending",
  `(7) a non-blocking running job still waits (${String(gradeGlJobState("running", false))})`,
);
// The reading of the raw field itself: GitLab sends booleans, an absent field is
// its own default (blocking), and a string `"true"` from an odd instance must not
// make a non-gate into a gate.
assert(glJobIsBlocking(undefined) === true, "(7) absent allow_failure means blocking");
assert(glJobIsBlocking(false) === true, "(7) allow_failure false means blocking");
assert(glJobIsBlocking(true) === false, "(7) allow_failure true means NOT blocking");
assert(glJobIsBlocking("true") === false, "(7) a string \"true\" is read as allow_failure");
assert(glJobIsBlocking("false") === true, "(7) a string \"false\" is read as blocking");

process.exit(exit);
