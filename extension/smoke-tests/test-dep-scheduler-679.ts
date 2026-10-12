#!/usr/bin/env bun
/**
 * Smoke test for the #679 dependency scheduler (split out of
 * test-work-driver-workstreams.ts, AGENTS.md §12 file-size limit).
 *
 * Covers: topological dispatch order, skip cascade, and resolveDependentBase.
 */

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 10b. #679 case 2(a)/2(b) — topological dispatch order + deferred worktree
// creation for a depends-on pair. The plan-quality gate guarantees a DAG;
// this test exercises the scheduler's topological ordering and the
// deferred worktree creation (from the dependency's post-commit SHA, not
// baseSha) without a real git repo (the execFn is mocked).
{
  const { topologicalDispatchOrder, computeSkipCascade } = await import(
    "../src/work-driver-dep-scheduler.ts"
  );

  // Topological order: A (independent), B depends on A, C depends on B.
  const ids = ["task-a", "task-b", "task-c"];
  const dependsOnMap = {
    "task-b": ["task-a"],
    "task-c": ["task-b"],
  };
  const { independent, dependentOrdered } = topologicalDispatchOrder(ids, dependsOnMap);
  assert(independent.length === 1 && independent[0] === "task-a", "#679: task-a is independent");
  assert(
    dependentOrdered.length === 2 &&
      dependentOrdered[0] === "task-b" &&
      dependentOrdered[1] === "task-c",
    "#679: topological order is task-b → task-c (C waits on B which waits on A)",
  );

  // Skip cascade: if task-a fails, task-b is skipped, and task-c is
  // transitively skipped (its dependency task-b was skipped).
  const failedOrSkipped = new Set(["task-a"]);
  const skips = computeSkipCascade(["task-b", "task-c"], dependsOnMap, failedOrSkipped);
  assert(skips.has("task-b"), "#679: task-b is skipped when its dependency task-a failed");
  assert(skips.has("task-c"), "#679: task-c is transitively skipped when task-b was skipped");

  // No failures → no skips.
  const noSkips = computeSkipCascade(["task-b", "task-c"], dependsOnMap, new Set());
  assert(noSkips.size === 0, "#679: no skips when no dependency failed");

  // The N=1 default path: no depends-on, all independent.
  const { independent: solo, dependentOrdered: soloDep } = topologicalDispatchOrder(
    ["default"],
    {},
  );
  assert(solo.length === 1 && solo[0] === "default", "#679: N=1 default is independent");
  assert(soloDep.length === 0, "#679: N=1 default has no dependent workstreams");
}

// 10c. #679 case 2(b) — resolveDependentBase with a mocked execFn: the
// dependent's base is the dependency's post-commit HEAD SHA (not baseSha).
{
  const { resolveDependentBase } = await import("../src/work-driver-dep-scheduler.ts");
  const FAKE_DEP_SHA = "a".repeat(40);
  const FAKE_BASE_SHA = "b".repeat(40);
  const mockExecFn = async (cmd: string) => {
    if (cmd === "git rev-parse HEAD") return { stdout: `${FAKE_DEP_SHA}\n` };
    if (cmd.startsWith("git rev-list --count")) return { stdout: "1\n" };
    return { stdout: "" };
  };
  const result = await resolveDependentBase(
    mockExecFn,
    "/repo",
    679,
    "task-b",
    ["task-a"],
    { "task-a": "/repo/.worktrees/issue-679-task-a" },
    { "task-a": FAKE_BASE_SHA },
    FAKE_BASE_SHA,
  );
  assert(
    result.fromRef === FAKE_DEP_SHA,
    "#679: the dependent's fromRef is the dependency's post-commit HEAD (not baseSha)",
  );
  assert(
    result.baseSha === FAKE_DEP_SHA,
    "#679: the dependent's effective base is the dependency's post-commit HEAD",
  );
  assert(result.skipReason === undefined, "#679: no skip reason when the dependency has commits");

  // Dependency with zero commits ahead of its base → skip (no baseSha fallback).
  const mockExecFnZero = async (cmd: string) => {
    if (cmd === "git rev-parse HEAD") return { stdout: `${FAKE_DEP_SHA}\n` };
    if (cmd.startsWith("git rev-list --count")) return { stdout: "0\n" };
    return { stdout: "" };
  };
  const zeroResult = await resolveDependentBase(
    mockExecFnZero,
    "/repo",
    679,
    "task-b",
    ["task-a"],
    { "task-a": "/repo/.worktrees/issue-679-task-a" },
    { "task-a": FAKE_BASE_SHA },
    FAKE_BASE_SHA,
  );
  assert(
    zeroResult.fromRef === undefined && zeroResult.skipReason !== undefined,
    "#679: a dependency with zero commits ahead of its base → the dependent is skipped (no baseSha fallback)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
