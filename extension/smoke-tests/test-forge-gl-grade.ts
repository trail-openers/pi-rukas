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
 *       string and a forge that capitalises must not silently become `unknown`.
 */

import { gradeGlJobState } from "../src/forge-gl-grade.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── (1) `success` is the only pass ───────────────────────────────────────
assert(gradeGlJobState("success") === "pass", "(1) success passes");
for (const s of ["running", "created", "manual", "skipped", "failed", "canceled", ""]) {
  assert(gradeGlJobState(s) !== "pass", `(1) "${s}" is NOT a pass (${String(gradeGlJobState(s))})`);
}

// ── (2) the red states ───────────────────────────────────────────────────
for (const s of ["failed", "canceled"]) {
  assert(gradeGlJobState(s) === "fail", `(2) ${s} is a fail (${String(gradeGlJobState(s))})`);
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
    gradeGlJobState(s) === "pending",
    `(3) ${s} is pending, so it is waited (${String(gradeGlJobState(s))})`,
  );
}

// ── (4) terminal but never green ─────────────────────────────────────────
for (const s of ["skipped", "manual"]) {
  assert(
    gradeGlJobState(s) === "not-green",
    `(4) ${s} is terminal and NOT green (${String(gradeGlJobState(s))})`,
  );
}

// ── (5) an unseen word is never a pass ───────────────────────────────────
for (const s of ["succeeded", "ok", "done", "passed", "???"]) {
  assert(
    gradeGlJobState(s) === "unknown",
    `(5) "${s}" is unknown, waited rather than passed (${String(gradeGlJobState(s))})`,
  );
}
// Absence says nothing, and nothing is not a pass: the caller must WAIT, and an
// expired wait hands the run back rather than merging on a blank.
for (const s of ["", "   ", "\t"]) {
  const g = gradeGlJobState(s);
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
    gradeGlJobState(raw) === want,
    `(6) "${raw}" grades ${want} (${String(gradeGlJobState(raw))})`,
  );
}

process.exit(exit);
