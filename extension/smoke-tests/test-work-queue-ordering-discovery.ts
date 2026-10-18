#!/usr/bin/env bun
/**
 * #1101 (discovery half) — reading a cross-group ordering edge out of issue
 * bodies, before the queue ever runs.
 *
 * The sibling of `test-work-queue-ordering.ts`, split out for AGENTS.md §12's
 * 500-line cap and because these assertions are about a pure text scan: no
 * queue, no injected `runGroup`, no timing. When an ordering bug is reported,
 * the first question is whether the queue saw the edge; this file answers it
 * without a dispatch in sight.
 *
 * Three things the scanner has to get right, each of which was wrong at some
 * point in this issue's history:
 *
 *  - **Narrow on purpose.** R1's `linkRe` also matches `fixes #N`, `related to
 *    #N`, `part of #N`. Handing that whole vocabulary to the queue would
 *    serialise every pair that happens to cite each other, so the ordering set
 *    is its own list — and `closes #12` being absent from it is a feature.
 *  - **Mootness is not invisibility.** An edge whose two ends R1 already
 *    merged, or whose target is not in this invocation, must not BLOCK; but it
 *    is still recorded, so an operator asking "why did the queue not order
 *    these two" gets an answer rather than silence.
 *  - **A cycle is decided here, not at dispatch.** Every member of an ordering
 *    loop parks, including a group merely downstream of one — a group whose
 *    dependency is unreachable has no valid order either, and letting it run
 *    builds a dependent before the thing it depends on.
 */

import {
  cycleEdgeLabels,
  findCyclicGroups,
  orderingDependencies,
  planOrderingEdges,
} from "../src/work-queue-deps.ts";
import type { IssueGroup } from "../src/work-queue.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function g(id: string, issue: number, paths: string[] = []): IssueGroup {
  return { id, scope: `issue #${issue}`, paths, outOfScope: [], issues: [issue] };
}

// ======================================= 1. The statement scanner is narrow
{
  // The words that mean ordering. `phrasings` is scoped to this block, which is
  // also the point of the block form: every section gets its own scope, so a
  // case cannot leak a binding into the next and satisfy an assertion against
  // another case's state.
  const phrasings: Array<[string, string]> = [
    ["depends-on colon", "Depends-on: #12"],
    ["depends on spaced", "depends on #12"],
    ["depends on sentence", "Depends on #12 before this ships"],
    ["blocked by", "blocked by #12"],
    ["blocked-by colon", "Blocked-by: #12"],
    ["blocked on", "blocked on #12"],
    // `requires` in its MARKER forms only — see the module header of
    // work-queue-deps.ts. A colon, or alone on its own line.
    ["requires colon", "Requires: #12"],
    ["requires lowercase colon", "requires: #12"],
    ["requires on its own line", "notes\nrequires #12"],
    ["predecessors", "predecessors are #12"],
  ];
  for (const [label, phrasing] of phrasings) {
    const deps = orderingDependencies(`title: x\n\n${phrasing} — see the other issue`);
    assert(deps.includes(12), `ordering statement recognised: "${phrasing}" (${label})`);
  }

  // The words that do NOT mean ordering — R1's vocabulary is wider on purpose
  // (it merges), and handing its whole set to the queue would serialise every
  // pair that cites each other.
  for (const notOrdering of [
    "closes #12",
    "fixes #12",
    "resolves #12",
    "related to #12",
    "companion to #12",
    "part of #12",
    "duplicate of #12",
    "this depends on the API being stable",
    // #1101 fix-round — the broad verb, in prose. `requires` is ordinary
    // English; the others are ordering vocabulary. A mid-sentence `requires #N`
    // is a property being described, not a schedule being declared, and the
    // false positive here is the expensive kind: the dependent waits behind a
    // group that was never its dependency and then gets parked blaming it.
    "this requires #12 to be understood first",
    "the module requires #12 semantics to hold",
    "we require #12 before merging",
  ]) {
    const deps = orderingDependencies(`title: x\n\n${notOrdering}`);
    assert(
      deps.length === 0,
      `"${notOrdering}" is NOT an ordering statement (no group to wait for)`,
    );
  }
  // #1101 fix-round — a number no issue can have is not an edge. The scanner
  // captures `#(\d+)`, so an unbounded digit run reaches `parseInt` intact:
  // `Depends-on: #99999999999999999999` parses to 1e20, which a
  // `Number.isFinite` guard lets through. It matches no group, so the statement
  // silently does nothing while claiming to order work — the expensive
  // direction, because an operator wrote a schedule and got no ordering.
  // `isSafeInteger` rejects it. (A float or exponent reference never reaches
  // the guard at all — `(\d+)` needs the `#` and stops at the dot or the `e` —
  // so those spellings are simply not statements, and are not asserted here.)
  const overflow = orderingDependencies("title: x\n\nDepends-on: #99999999999999999999");
  assert(
    overflow.length === 0,
    `an overflowing issue number is not an edge (got: ${overflow.join(", ")})`,
  );
  assert(
    orderingDependencies("title: x\n\nDepends-on: #12").join(",") === "12",
    "a real reference still produces its edge — the guard does not over-reject",
  );

  assert(orderingDependencies(undefined).length === 0, "an absent body declares nothing");
  assert(
    orderingDependencies("no references at all").length === 0,
    "a body with no numbered reference declares nothing",
  );
}

// ============================ 2. planOrderingEdges: collapse, ignore, mootness
{
  const groups = [g("group-a", 100), g("group-b", 101), g("group-c", 102)];
  const plan = planOrderingEdges(
    groups.map((x) => ({ id: x.id, issues: x.issues })),
    // 101 depends on 100 (cross-group); 102 depends on 999 (outside the
    // invocation); 100 depends on 100 (self-reference).
    { 100: [100], 101: [100], 102: [999] },
  );
  assert(
    plan.byGroup["group-b"]?.blockingGroupIds.join(",") === "group-a",
    "a cross-group statement becomes one edge: group-b waits for group-a",
  );
  assert(
    (plan.byGroup["group-a"]?.blockingGroupIds ?? []).length === 0,
    "a self-reference is not an edge (nothing to wait for)",
  );
  assert(
    (plan.byGroup["group-c"]?.blockingGroupIds ?? []).length === 0,
    "a dependency outside the invocation does NOT block dispatch",
  );
  assert(
    plan.byGroup["group-c"]?.ignored.join(",") === "102",
    "the out-of-invocation dependency is recorded once, for the log",
  );
  assert(
    plan.notes.filter((n) => n.startsWith("ordering ignored")).length === 2,
    "each ignored edge is noted exactly once per issue (not once per statement)",
  );
  assert(plan.cyclic.length === 0, "an acyclic graph reports no cyclic groups");

  // Same-group: R1 merged them, so the edge is intra-group and moot.
  const merged = planOrderingEdges(
    [
      { id: "group-a", issues: [100, 101] },
      { id: "group-b", issues: [102] },
    ],
    { 101: [100] },
  );
  assert(
    (merged.byGroup["group-a"]?.blockingGroupIds ?? []).length === 0,
    "an edge inside one group is not a blocker (R1 merged it deliberately)",
  );
  assert(
    merged.byGroup["group-a"]?.sameGroup.join(",") === "101",
    "the same-group edge is still recorded (so the operator can see it was considered)",
  );
}

// ================================================= 3. Cycle detection
{
  const groups = [g("group-a", 100), g("group-b", 101), g("group-c", 102)];
  const plan = planOrderingEdges(
    groups.map((x) => ({ id: x.id, issues: x.issues })),
    { 100: [101], 101: [100], 102: [] },
  );
  assert(
    plan.cyclic.sort().join(",") === "group-a,group-b",
    "a 2-cycle names both groups and leaves the unrelated one alone",
  );
  const labels = cycleEdgeLabels(plan.cyclic, plan.byGroup);
  assert(
    labels.includes("group-a → group-b") && labels.includes("group-b → group-a"),
    "the cycle is reported as its edges, so the operator can see which line to edit",
  );

  // A 3-cycle.
  const three = planOrderingEdges(
    groups.map((x) => ({ id: x.id, issues: x.issues })),
    { 100: [102], 101: [100], 102: [101] },
  );
  assert(three.cyclic.length === 3, "a 3-cycle parks all three groups — there is no valid order");

  // A chain is not a cycle.
  const chain = planOrderingEdges(
    groups.map((x) => ({ id: x.id, issues: x.issues })),
    { 101: [100], 102: [101] },
  );
  assert(chain.cyclic.length === 0, "A→B→C is a chain, not a cycle");
  assert(
    findCyclicGroups(["a"], { a: { blockingGroupIds: ["a"] } }).join(",") === "a",
    "a self-edge in the graph is treated as a cycle (defensive: planOrderingEdges filters these)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
