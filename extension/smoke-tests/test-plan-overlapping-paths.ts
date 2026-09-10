#!/usr/bin/env bun
/**
 * Two workstreams must not be pointed at the same file.
 *
 * The plan step decomposes an issue into N workstreams, each with a declared
 * `paths` list, and `runDevelop` fans out one developer per workstream into its
 * own worktree. Nothing checked that those lists are disjoint — a repo-wide
 * grep for `overlap|disjoint|intersect` found no workstream-level check at all;
 * the only Jaccard logic groups *issues*, not workstreams.
 *
 * The collision surfaces much later as a bare `git apply` failure during
 * commit-pr consolidation — a HALT step, after the full develop and adversarial
 * spend, with an error that says nothing about why two workstreams wanted the
 * same file.
 *
 * Not hypothetical: measured on this host, current cycles are routinely N>1
 * (lantern 664 = 3 workstreams, 673 = 2, 677 = 3).
 *
 * This is a plan-quality defect of exactly the shape `planQualityReason`
 * already models, so it becomes a third reason and inherits the existing
 * one-shot corrective re-dispatch. The planner can re-split; a halt would be
 * more code and a worse outcome.
 */

// #679 — import from the canonical module (the stale duplicate copy in
// work-driver-plan-helpers.ts was deleted; work-driver-plan.ts re-exports it).
import { correctivePlanSteer, planQualityReason } from "../src/work-driver-plan.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ws = (paths: Record<string, string[]>) =>
  Object.fromEntries(Object.entries(paths).map(([id, p]) => [id, { paths: p }]));

// A findings count that does not itself trigger "under-decomposed" for N>=2.
const OK_FINDINGS = 2;

// ------------------------------------------------------------- the collision

{
  const reason = planQualityReason(
    ws({ "task-a": ["src/a.ts", "src/b.ts"], "task-b": ["src/b.ts", "src/c.ts"] }),
    OK_FINDINGS,
  );
  assert(
    reason === "overlapping-paths",
    `canary: two workstreams declaring src/b.ts is caught at plan time (got ${reason}) — it used to surface as a git apply failure at commit-pr`,
  );
}

{
  // Directory containment is overlap: a developer told to own `src/foo` and one
  // told to own `src/foo/bar.ts` are editing the same file.
  assert(
    planQualityReason(ws({ a: ["src/foo"], b: ["src/foo/bar.ts"] }), OK_FINDINGS) ===
      "overlapping-paths",
    "canary: a directory containing another workstream's file overlaps",
  );
  assert(
    planQualityReason(ws({ a: ["src/foo/bar.ts"], b: ["src/foo"] }), OK_FINDINGS) ===
      "overlapping-paths",
    "...in either order",
  );
}

{
  // The planner writes prose, not `git` output. `normaliseDeclaredPath` already
  // handles that for the consolidation gate; the same rule applies here or the
  // check is trivially evaded by an annotation.
  assert(
    planQualityReason(ws({ a: ["src/a.ts (new)"], b: ["`src/a.ts`"] }), OK_FINDINGS) ===
      "overlapping-paths",
    "canary: annotations and backticks do not hide an overlap",
  );
}

// --------------------------------------------------------------- not overlap

{
  assert(
    planQualityReason(ws({ a: ["src/a.ts"], b: ["src/b.ts"] }), OK_FINDINGS) === undefined,
    "disjoint workstreams are fine",
  );
  assert(
    planQualityReason(ws({ a: ["src/foo/a.ts"], b: ["src/foobar/b.ts"] }), OK_FINDINGS) ===
      undefined,
    "canary: a shared PREFIX is not containment — src/foo does not contain src/foobar",
  );
  assert(
    planQualityReason(ws({ default: ["src/a.ts", "src/a.ts"] }), 1) === undefined,
    "one workstream cannot overlap itself, even repeating a path",
  );
}

// ------------------------------------------- the pre-existing reasons survive

{
  assert(
    planQualityReason(ws({ default: ["src/a.ts"] }), 5) === "under-decomposed",
    "under-decomposed still fires",
  );
  assert(
    planQualityReason(ws({ a: ["src/a.ts"], b: [] }), OK_FINDINGS) === "empty-paths",
    "empty-paths still fires",
  );
  // Precedence: an empty list cannot overlap anything, so empty-paths is the
  // more specific diagnosis and must win.
  assert(
    planQualityReason(ws({ a: ["src/a.ts"], b: [], c: ["src/a.ts"] }), OK_FINDINGS) ===
      "empty-paths",
    "an empty list is reported as empty-paths, not as the overlap it cannot participate in",
  );
}

// ----------------------------------------------------- the steer is actionable

{
  const steer = correctivePlanSteer("overlapping-paths", OK_FINDINGS, 2, [
    { a: "task-a", b: "task-b", path: "src/b.ts" },
  ]);
  assert(/task-a/.test(steer) && /task-b/.test(steer), "the steer names both workstreams");
  assert(/src\/b\.ts/.test(steer), "...and the path they collide on");
  assert(
    /Corrective re-dispatch/.test(steer),
    "...in the shape the existing corrective dispatch expects",
  );
  assert(
    !steer.includes("undefined"),
    "canary: no 'undefined' leaks into the steer when details are supplied",
  );
}

{
  // The other reasons must still render without collision details.
  for (const r of ["under-decomposed", "empty-paths"] as const) {
    const s = correctivePlanSteer(r, 6, 1);
    assert(s.length > 0 && !s.includes("undefined"), `${r} still renders without details`);
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
