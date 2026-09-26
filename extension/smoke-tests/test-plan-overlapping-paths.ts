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
 * (nessie 664 = 3 workstreams, 673 = 2, 677 = 3).
 *
 * This is a plan-quality defect of exactly the shape `planQualityReason`
 * already models, so it becomes a third reason and inherits the existing
 * one-shot corrective re-dispatch. The planner can re-split; a halt would be
 * more code and a worse outcome.
 */

// #679 — import from the canonical module (the stale duplicate copy in
// work-driver-plan-helpers.ts was deleted; work-driver-plan.ts re-exports it).
import { correctivePlanSteer, planQualityReason } from "../src/work-driver-plan.ts";
import { findDroppedDependencyEdges } from "../src/work-driver-plan-helpers.ts";

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
  for (const r of [
    "under-decomposed",
    "empty-paths",
    "test-subject-split",
    "invalid-dependency",
    "circular-dependency",
    "interdependent-no-integration-test",
    "dropped-dependencies",
  ] as const) {
    const s = correctivePlanSteer(r, 6, 1);
    assert(s.length > 0 && !s.includes("undefined"), `${r} still renders without details`);
  }
}

// ------------------------------------- #849 — the steer carries the dependsOn

{
  const steer = correctivePlanSteer("overlapping-paths", OK_FINDINGS, 2, [
    { a: "task-a", b: "task-b", path: "src/b.ts" },
  ]);
  assert(
    /depends-on/.test(steer),
    "#849: the steer instructs the planner to preserve or ADD a `- depends-on:` line",
  );
  assert(
    /CONSUMES an artifact another/.test(steer) || /consumes an artifact/i.test(steer),
    "#849: the steer names the consumer→creator dependency the edge is for",
  );
  assert(
    /MERGE them into one workstream/i.test(steer),
    "#849: the steer instructs the planner to MERGE workstreams that would both create the same artifact",
  );
}

// ------------------------------------- #849 — dropped-dependencies detection

{
  const first = {
    "task-a": { paths: ["src/a.ts"], dependsOn: ["task-b"] },
    "task-b": { paths: ["src/b.ts"] },
  };

  // DROPPED: the corrective re-plan keeps both workstreams (disjoint paths,
  // same ids) but drops the edge. This is the #814 shape.
  const dropped = findDroppedDependencyEdges(first, {
    "task-a": { paths: ["src/a.ts"] },
    "task-b": { paths: ["src/b.ts"] },
  });
  assert(
    dropped.length === 1,
    "#849: a corrective that keeps both workstreams but drops the edge → dropped",
  );
  assert(
    dropped[0]?.from === "task-a" && dropped[0]?.to === "task-b",
    "#849: the dropped edge names the original from→to",
  );

  // PRESERVED (same ids, same paths): no flag.
  assert(
    findDroppedDependencyEdges(first, {
      "task-a": { paths: ["src/a.ts"], dependsOn: ["task-b"] },
      "task-b": { paths: ["src/b.ts"] },
    }).length === 0,
    "#849: a corrective that preserves the edge → no flag",
  );

  // MERGED: the corrective merged the two workstreams (union of paths) into
  // one — the overlap fix the steer explicitly allows. No flag.
  assert(
    findDroppedDependencyEdges(first, {
      merged: { paths: ["src/a.ts", "src/b.ts"] },
    }).length === 0,
    "#849: a corrective that merges the pair into one workstream → no flag (the overlap fix)",
  );

  // MERGED with a RENAME to the merged id (typical corrective output):
  // the merged workstream's id is a new one, but its path set still covers
  // both old endpoints. No flag.
  assert(
    findDroppedDependencyEdges(first, {
      "task-c": { paths: ["src/a.ts", "src/b.ts"] },
    }).length === 0,
    "#849: a merged pair under a new id is still recognised as merged",
  );

  // PRESERVED under a RENAME: the corrective renamed both ids but kept the
  // same path sets and the dependency between them. No flag.
  assert(
    findDroppedDependencyEdges(first, {
      "ws-a": { paths: ["src/a.ts"], dependsOn: ["ws-b"] },
      "ws-b": { paths: ["src/b.ts"] },
    }).length === 0,
    "#849: a renamed pair with the edge preserved → no flag (path-set signature match)",
  );

  // DROPPED under a RENAME: the corrective renamed both ids, kept the same
  // path sets, but dropped the edge. Flag.
  assert(
    findDroppedDependencyEdges(first, {
      "ws-a": { paths: ["src/a.ts"] },
      "ws-b": { paths: ["src/b.ts"] },
    }).length === 1,
    "#849: a renamed pair with the edge dropped → still flagged (path-set signature match)",
  );

  // Multiple edges, one dropped: only the dropped one is reported.
  const multi = {
    "task-a": { paths: ["src/a.ts"], dependsOn: ["task-b", "task-c"] },
    "task-b": { paths: ["src/b.ts"] },
    "task-c": { paths: ["src/c.ts"] },
  };
  const partial = findDroppedDependencyEdges(multi, {
    "task-a": { paths: ["src/a.ts"], dependsOn: ["task-b"] },
    "task-b": { paths: ["src/b.ts"] },
    "task-c": { paths: ["src/c.ts"] },
  });
  assert(partial.length === 1, "#849: with two edges, only the dropped one is reported");
  assert(
    partial[0]?.from === "task-a" && partial[0]?.to === "task-c",
    "#849: the preserved edge (task-a→task-b) is not reported",
  );

  // No edges in the first plan: nothing to drop.
  assert(
    findDroppedDependencyEdges(
      { "task-a": { paths: ["src/a.ts"] } },
      { "task-a": { paths: ["src/a.ts"] } },
    ).length === 0,
    "#849: a plan with no dependsOn edges has nothing to drop",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
