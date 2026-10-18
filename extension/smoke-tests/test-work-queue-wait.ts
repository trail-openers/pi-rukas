#!/usr/bin/env bun
/**
 * #1101 — what the queue's WAIT actually waits for.
 *
 * `test-work-queue-preflight-overlap.ts` owns the pre-dispatch overlap policy
 * and `test-work-queue-dlq.ts` owns what parks versus halts; both grew #1101
 * cases that are really about a third thing, so they live here: the wait is on
 * a sibling's SETTLEMENT, not on its claim, and the ordering edge is the only
 * signal the queue has when the overlap predicate is structurally blind.
 *
 * Why that distinction is the bug and not a nuance: a group is claimed and then
 * sits running for the entire length of its cycle. Every "started after the
 * claim" assertion in the pre-#1101 suite was therefore satisfied by two cycles
 * editing the same files at the same time — it asserted an ordering that had no
 * safety content. The moment that matters is `runGroup` resolving with its
 * outcome recorded, so each case below captures settlement INSIDE the stub and
 * asserts against that capture rather than inferring it from dispatch order.
 *
 * No Pi spawn, no fs: `runWorkQueue` with an injected `runGroup`, following
 * test-work-queue-dlq.ts conventions.
 */

import { type IssueGroup, runWorkQueue } from "../src/work-queue.ts";
import type { WorkState } from "../src/workflow-state.ts";

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

function mkState(
  issue: number,
  status: WorkState["pipelineState"]["status"] = "merged",
): WorkState {
  return {
    schemaVersion: 1,
    issue,
    // biome-ignore lint/suspicious/noExplicitAny: only the fields the queue reads matter
    pipelineState: { status, currentStep: "merged", lastCompletedStep: "ci" } as any,
    eventLog: [],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any;
}

// ============================= 1. The wait is on SETTLEMENT, not on the claim
{
  const order: string[] = [];
  let aSettled = false;
  let bStartedWhileAHeldTheClaim = false;
  const groups: IssueGroup[] = [
    g("group-a", 100, ["src/shared.ts"]),
    g("group-b", 101, ["src/shared.ts"]),
  ];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 2,
    runGroup: async (primary) => {
      if (primary === 100) {
        order.push("a:start");
        await new Promise((r) => setTimeout(r, 60));
        // The last thing the cycle does before it stops holding the claim.
        // Anything group-b can observe before this line is, by definition,
        // alongside a live cycle.
        order.push("a:settle");
        aSettled = true;
        return { started: true };
      }
      order.push("b:start");
      bStartedWhileAHeldTheClaim = !aSettled;
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue),
  });
  assert(
    !bStartedWhileAHeldTheClaim,
    "#1101: the overlapping sibling did not start until the first group's runGroup SETTLED (not merely until it was claimed)",
  );
  assert(
    order.indexOf("a:settle") < order.indexOf("b:start"),
    "the settlement is recorded strictly before the dependent's dispatch",
  );
  assert(summary.merged === 2, "both groups merged — the wait cost serialisation, not a park");
}

// ============ 2. Plan-declared overlap with EMPTY extracted paths
//
// The root cause of the plan-time park, and the case the overlap predicate is
// structurally blind to. `groupPathsOverlap` answers "no overlap" for an empty
// set on either side, so a pair whose bodies name no path at all runs
// concurrently — and the reactive plan-time claim check, which reads what the
// PLANNER declared, then parks the loser after an explore + plan dispatch.
// Here the queue cannot predict the collision from the bodies either, so the
// only signal it has is the ordering edge, and the contract is that it holds
// the group back rather than letting the reactive check park it after the spend.
{
  const started: number[] = [];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    // Both sides extracted nothing: the overlap predicate is a no-op by
    // contract, and this is exactly the shape that used to reach plan.
    groups: [g("group-a", 100, []), g("group-b", 101, [])],
    restart: false,
    concurrency: 2,
    // The dependency is the only thing that separates the pair.
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    deferCapMs: 5_000,
    runGroup: async (primary) => {
      started.push(primary);
      await new Promise((r) => setTimeout(r, primary === 100 ? 40 : 5));
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue),
  });
  assert(
    started.indexOf(101) > started.indexOf(100),
    "an ordering edge holds the dependent even where the overlap predicate is blind (both sides extracted no paths)",
  );
  assert(
    !summary.entries.some((e) => /cross-group-conflict/.test(e.reason ?? "")),
    "no group reached the reactive plan-time park — the queue waited instead of burning a dispatch",
  );
  assert(summary.merged === 2, "and nothing parks once the dependency merges");
}

// ================================================= 3. A dependency's own park
//
// The #368 contract applied to the ordering edge, and the reason the two
// features have to be tested together: #368 says a failed group parks and the
// queue continues; #1101 says a dependent must not run before its dependency
// merges. Run together, the failure modes are a dependent that dispatches
// anyway (the original bug) or a queue that halts behind a dependency that
// merely parked for its own unrelated reason (a regression against #368, and
// the likelier mistake, because a parked dependency looks systemic to a queue
// reading the wrong state file).
//
// The load-bearing assertion is `runGroup` never being invoked for the
// dependent. A park that dispatches first and reports honestly afterwards still
// costs an explore + plan dispatch, which is the entire expense #1101 exists to
// avoid.
{
  const ran: number[] = [];
  const states = new Map<number, WorkState>([
    [100, mkState(100, "handoff")], // the dependency parks on its own review cap
    [101, mkState(101, "merged")],
    [102, mkState(102, "merged")],
    [103, mkState(103, "merged")],
    [104, mkState(104, "merged")],
  ]);
  const groups: IssueGroup[] = [
    g("group-a", 100),
    g("group-b", 101),
    g("group-c", 102),
    g("group-d", 103),
    g("group-e", 104),
  ];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 1,
    // group-b (#101) waits for group-a (#100); group-a parks.
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    runGroup: async (primary) => {
      ran.push(primary);
    },
    readStateFn: async (_r, issue) => states.get(issue),
  });

  assert(
    !ran.includes(101),
    "the dependent's runGroup is NEVER invoked — a park that dispatches first still burns the dispatch",
  );
  assert(ran.includes(100), "the dependency itself ran and parked normally");
  const dependent = summary.entries.find((e) => e.groupId === "group-b");
  assert(
    dependent?.outcome === "parked" && /cap dependency-parked:#100/.test(dependent.reason ?? ""),
    `the dependent parks dependency-parked:#100, naming the dependency (got: ${dependent?.reason})`,
  );
  assert(
    /never started|nothing was built/.test(dependent?.humanAction ?? ""),
    "the action says plainly that nothing was built, so nobody hunts for a phantom diff",
  );
  assert(
    ran.join(",") === "100,102,103,104",
    "#368 still holds across the edge: the queue continues past a parked dependency — three unrelated groups ran",
  );
  assert(
    summary.notStarted.length === 0,
    "a group the queue parked is a PARK, not a group it never reached",
  );
  assert(
    !summary.entries.some((e) => e.outcome === "halted"),
    "a dependency's issue-scoped park is not systemic — it halts nothing",
  );
}

{
  // A dependency that REFUSED to start is also non-merged, and the dependent
  // must not wait on a cycle that will never merge. This is the case a naive
  // "wait until the dependency is done" implementation gets wrong: a group that
  // never started is not "still running", and a queue that cannot tell the two
  // apart waits for a merge that cannot happen.
  const ran: number[] = [];
  const groups: IssueGroup[] = [g("group-a", 100), g("group-b", 101), g("group-c", 102)];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 1,
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    runGroup: async (primary) => {
      ran.push(primary);
      return primary === 100
        ? { started: false, reason: "another live process owns the cycle for #100" }
        : { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(
    !ran.includes(101),
    "a dependency that never started does not release its dependent either",
  );
  assert(
    /dependency-parked/.test(summary.entries.find((e) => e.groupId === "group-b")?.reason ?? ""),
    "and the dependent parks rather than waiting for a merge that cannot happen",
  );
  assert(ran.includes(102), "the unrelated group still ran");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
