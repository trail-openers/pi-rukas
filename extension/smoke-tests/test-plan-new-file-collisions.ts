#!/usr/bin/env bun
/**
 * #1581 — two workstreams must not each create the same NEW file.
 *
 * `findPathCollisions` compared declared `paths` only, so a plan whose
 * workstreams each said in their scope that they would add the same new file
 * (neither declaring it) passed the plan gate, and the two copies met at
 * consolidation as an add/add conflict, after the whole develop spend.
 *
 * The prediction is read from planner prose, so the negative cases matter as
 * much as the positive one: a file only one workstream creates, a sibling that
 * merely mentions it, and a scope naming no file must all still pass.
 */

import { findPathCollisions, newFilesOf } from "../src/work-driver-plan-paths.ts";
import { correctivePlanSteer, planQualityReason } from "../src/work-driver-plan.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const OK_FINDINGS = 2;

// --------------------------------------------------------------- collisions

{
  // The shape from the 674 explore reply: both halves add a new module, with
  // disjoint declared paths.
  const plan = {
    "task-a": {
      scope: "worktree side, extracted to a new module (e.g. work-driver-handoff-forge.ts)",
      paths: ["extension/src/work-driver-handoff-recovery.ts"],
    },
    "task-b": {
      scope: "forge retry; create extension/src/work-driver-handoff-forge.ts",
      paths: ["extension/src/work-driver-handoff.ts"],
    },
  };
  const reason = planQualityReason(plan, OK_FINDINGS);
  assert(
    reason === "overlapping-paths",
    `two workstreams each creating the same undeclared new file are rejected at plan time (got ${reason})`,
  );
  const collisions = findPathCollisions(plan);
  const steer = correctivePlanSteer("overlapping-paths", OK_FINDINGS, 2, collisions);
  assert(
    /task-a/.test(steer) && /task-b/.test(steer) && /work-driver-handoff-forge\.ts/.test(steer),
    "the corrective steer names both workstreams and the new file",
  );
}
{
  // Bare basename in one scope, full path in the other.
  const plan = {
    "task-a": { scope: "plus a new test-handoff-post-retry.ts", paths: ["src/a.ts"] },
    "task-b": {
      scope: "adds a new extension/smoke-tests/test-handoff-post-retry.ts",
      paths: ["src/b.ts"],
    },
  };
  assert(
    planQualityReason(plan, OK_FINDINGS) === "overlapping-paths",
    "a bare new filename and the full path of the same new file collide",
  );
}
{
  // A declared `(new)` path against another workstream's scope intent.
  const plan = {
    "task-a": { scope: "core", paths: ["src/x.ts (new)"] },
    "task-b": { scope: "wiring, creates a new file src/x.ts", paths: ["src/y.ts"] },
  };
  assert(
    planQualityReason(plan, OK_FINDINGS) === "overlapping-paths",
    "a declared (new) path and a sibling's scope that also creates it collide",
  );
}

// ----------------------------------------------------------- not collisions

{
  const plan = {
    "task-a": { scope: "core, creates src/x.ts", paths: ["src/x.ts (new)"] },
    "task-b": { scope: "wiring, uses the new helper in src/x.ts", paths: ["src/y.ts"] },
  };
  assert(
    planQualityReason(plan, OK_FINDINGS) === undefined,
    "a new file one workstream creates and a sibling only references still passes",
  );
}
{
  const plan = {
    "task-a": { scope: "creates new src/x.ts", paths: ["src/a.ts"] },
    "task-b": { scope: "creates new src/z.ts", paths: ["src/b.ts"] },
  };
  assert(
    planQualityReason(plan, OK_FINDINGS) === undefined,
    "two workstreams each creating a distinct new file still pass",
  );
}
{
  const plan = {
    "task-a": { scope: "rework the retry loop", paths: ["src/a.ts"] },
    "task-b": { scope: "document the new behaviour", paths: ["src/b.ts"] },
  };
  assert(
    planQualityReason(plan, OK_FINDINGS) === undefined,
    "scopes naming no file are unaffected (the read fails open)",
  );
}
{
  // Same-directory, different files must not collide by basename rule.
  const plan = {
    "task-a": { scope: "new src/a/index.ts", paths: ["src/a.ts"] },
    "task-b": { scope: "new src/b/index.ts", paths: ["src/b.ts"] },
  };
  assert(
    planQualityReason(plan, OK_FINDINGS) === undefined,
    "two new files sharing only a basename in different directories do not collide",
  );
}
{
  // Reviewer-found shapes: a sibling naming the creator's file as "the new
  // <file>", or in an aside about another workstream, is not a second creator.
  const plan = {
    "task-a": { scope: "core, create src/foo.ts", paths: ["src/a.ts"] },
    "task-b": {
      scope: "tests for the new src/foo.ts (task-a creates src/foo.ts)",
      paths: ["src/b.ts"],
    },
  };
  assert(
    planQualityReason(plan, OK_FINDINGS) === undefined,
    "a sibling referring to 'the new <file>' or to another workstream's creation still passes",
  );
}
{
  const plan = {
    "task-a": { scope: "create a new index.ts", paths: ["src/a.ts"] },
    "task-b": { scope: "create src/b/index.ts", paths: ["src/b.ts"] },
  };
  assert(
    planQualityReason(plan, OK_FINDINGS) === undefined,
    "a generic bare basename (index.ts) never collides by basename alone",
  );
}
{
  assert(
    newFilesOf({ scope: "see e.g. the notes", paths: [] }).length === 0,
    "an abbreviation such as e.g. is not read as a file",
  );
}

process.exit(exit);
