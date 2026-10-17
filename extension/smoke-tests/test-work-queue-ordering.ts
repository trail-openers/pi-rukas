#!/usr/bin/env bun
/**
 * #1101 — the `/work` queue starts dependent issues before their dependencies.
 *
 * The operator-visible failure: `/work 12 13` where 13 says `Depends-on: #12`.
 * R1 merges issues that *declare* a dependency into one group only when the
 * statement matches its link regex; where it does not, or where an R3 split /
 * a group-size split pulls them apart, the queue had NO ordering notion at
 * all. The dependent started alongside its dependency, and the queue's only
 * pre-dispatch gate is a path-overlap check that keys on extracted tokens. The
 * second cycle then parked at plan with `cross-group-conflict` — after an
 * explore + plan dispatch, with the root cause nowhere in the message.
 *
 * Contract this locks down:
 *   - A dependent group's `runGroup` is not invoked until its dependency group
 *     reaches `merged`.
 *   - A dependency that settles on anything else parks the dependent with
 *     `dependency-parked:#N`, WITHOUT invoking `runGroup`.
 *   - An ordering cycle parks every group in it with `dependency-cycle` before
 *     any dispatch.
 *   - A dependency outside the invocation is ignored and noted once, and never
 *     blocks dispatch.
 *   - An ordering edge governs over an overlap between the same pair, and
 *     contributes exactly one park reason.
 *   - Disjoint groups with no edges still run concurrently (the #289 peak
 *     invariant, restated for the new gate: the ordering check must not
 *     serialise what has no edge).
 *   - A wait that outlasts its bound parks with a named cap instead of
 *     proceeding (the pre-#1101 behaviour, deliberately reversed).
 *
 * No Pi spawn, no fs: `runWorkQueue` with an injected `runGroup`, following
 * test-work-queue-dlq.ts conventions.
 */
import { planOrderingEdges } from "../src/work-queue-deps.ts";
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

function mkState(issue: number, status: WorkState["pipelineState"]["status"] = "merged"): WorkState {
  return {
    schemaVersion: 1,
    issue,
    // biome-ignore lint/suspicious/noExplicitAny: only the fields the queue reads matter
    pipelineState: { status, currentStep: "merged", lastCompletedStep: "ci" } as any,
    eventLog: [],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any;
}

// ===================== 4. The dependent does not dispatch until merged=true
{
  const started: number[] = [];
  const seen: string[] = [];
  const groups = [g("group-a", 100), g("group-b", 101)];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 2,
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    runGroup: async (primary) => {
      started.push(primary);
      // The dependency is held open long enough that a naive concurrent
      // worker would claim 101 while 100 is still running.
      await new Promise((r) => setTimeout(r, primary === 100 ? 70 : 5));
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(started.join(",") === "100,101", "the dependent ran strictly after its dependency");
  assert(summary.merged === 2, "both groups merged — the ordering wait did not consume either");
  assert(summary.parked === 0, "nothing parked when the dependency merged");
  void seen;
}

// ================== 5. A forward edge: dependency LATER in the list
{
  // The shape the earlier-index-only rule could not see. group-a (index 0)
  // depends on group-b (index 1); the old check looked only backwards and so
  // dispatched group-a immediately.
  const started: number[] = [];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: [g("group-a", 100), g("group-b", 101)],
    restart: false,
    concurrency: 2,
    dependencies: { "group-a": { blockingGroupIds: ["group-b"] } },
    runGroup: async (primary) => {
      started.push(primary);
      await new Promise((r) => setTimeout(r, primary === 101 ? 60 : 5));
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(
    started.indexOf(101) < started.indexOf(100),
    "an edge pointing FORWARD is honoured — the old earlier-index-only rule dispatched the dependent first",
  );
  assert(summary.merged === 2, "both groups still ran");
}

// ================== 6. Dependency parked → dependent parks, never dispatches
{
  const started: number[] = [];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: [g("group-a", 100), g("group-b", 101), g("group-c", 102)],
    restart: false,
    concurrency: 1,
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    runGroup: async (primary) => {
      started.push(primary);
      return { started: true };
    },
    readStateFn: async (_r, issue) =>
      issue === 100
        ? {
            schemaVersion: 1,
            issue: 100,
            // biome-ignore lint/suspicious/noExplicitAny: only the read fields matter
            pipelineState: { status: "handoff", currentStep: "plan", lastCompletedStep: "explore" } as any,
            // biome-ignore lint/suspicious/noExplicitAny: partial fixture
            eventLog: [{ kind: "cap-hit", at: 1, cap: "round-cap", reviewRound: 1, nextStep: "handoff" }] as any,
          } as unknown as WorkState
        : mkState(issue, "merged"),
  });
  assert(!started.includes(101), "the dependent NEVER dispatched — its dependency did not merge");
  const dependent = summary.entries.find((e) => e.groupId === "group-b");
  assert(
    dependent?.outcome === "parked" && /dependency-parked:#100/.test(dependent.reason ?? ""),
    "the dependent parks with dependency-parked:#100, naming the issue",
  );
  assert(
    /never started/.test(dependent?.humanAction ?? ""),
    "the action says plainly that nothing was built (no phantom diff to review)",
  );
  assert(
    summary.entries.some((e) => e.groupId === "group-c" && e.outcome === "merged"),
    "an unrelated group is unaffected — a dependency park is not a halt",
  );
}

// ========== 7. A dependency that refused to start also parks the dependent
{
  // `started: false` is a terminal outcome too: the cycle never ran, so it
  // will not merge. Waiting for it is waiting for nothing.
  const started: number[] = [];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: [g("group-a", 100), g("group-b", 101)],
    restart: false,
    concurrency: 1,
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    runGroup: async (primary) => {
      started.push(primary);
      return primary === 100
        ? { started: false, reason: "another live process owns the cycle for #100" }
        : { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(!started.includes(101), "a dependency that never started does not release its dependent");
  assert(
    /dependency-parked/.test(
      summary.entries.find((e) => e.groupId === "group-b")?.reason ?? "",
    ),
    "the dependent parks rather than waiting on a cycle that will never merge",
  );
}

// ============= 8. Precedence: ordering edge + path overlap → ONE park reason
{
  // group-b both depends on group-a and overlaps its paths. The ordering edge
  // must govern; the claim check must not add a second reason to the same
  // group.
  const started: number[] = [];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: [g("group-a", 100, ["src/shared.ts"]), g("group-b", 101, ["src/shared.ts"])],
    restart: false,
    concurrency: 2,
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    runGroup: async (primary) => {
      started.push(primary);
      await new Promise((r) => setTimeout(r, 10));
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(
    started.indexOf(100) < started.indexOf(101),
    "with both an edge and an overlap, the ordering edge serialises the pair",
  );
  const b = summary.entries.find((e) => e.groupId === "group-b");
  assert(b?.outcome === "merged", "the pair merged — the overlap did not manufacture a park");
  const reasons = summary.entries
    .filter((e) => /cross-group-conflict|dependency-/.test(e.reason ?? ""))
    .map((e) => e.groupId);
  assert(reasons.length === 0, "neither cap fired for a pair that both merged cleanly");
}

{
  // Same pair, dependency parks: exactly ONE reason, and it is the ordering
  // one (the claim wait adds nothing on top).
  const started: number[] = [];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: [g("group-a", 100, ["src/shared.ts"]), g("group-b", 101, ["src/shared.ts"])],
    restart: false,
    concurrency: 2,
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    runGroup: async (primary) => {
      started.push(primary);
      return { started: true };
    },
    readStateFn: async (_r, issue) =>
      issue === 100
        ? ({
            schemaVersion: 1,
            issue: 100,
            // biome-ignore lint/suspicious/noExplicitAny: only the read fields matter
            pipelineState: { status: "handoff", currentStep: "plan", lastCompletedStep: "plan" } as any,
            eventLog: [] as any,
          } as unknown as WorkState)
        : mkState(issue, "merged"),
  });
  const b = summary.entries.find((e) => e.groupId === "group-b");
  const reason = b?.reason ?? "";
  assert(
    /dependency-parked/.test(reason) && !/cross-group-conflict/.test(reason),
    `the dependent carries ONE reason, the ordering one (got: ${reason})`,
  );
  assert(!started.includes(101), "and it never dispatched");
}

// ==================== 9. Disjoint groups with no edges stay concurrent
{
  // The #289 peak-concurrency invariant, restated where it is now at risk:
  // the ordering gate must be a no-op for groups with no edge.
  let live = 0;
  let peak = 0;
  const groups = [g("group-a", 100, ["src/a.ts"]), g("group-b", 101, ["src/b.ts"]), g("group-c", 102, ["src/c.ts"])];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 3,
    dependencies: {},
    runGroup: async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      live -= 1;
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(peak === 3, `disjoint, edge-free groups still run at full concurrency (peak ${peak})`);
  assert(summary.merged === 3, "all three merged");
}

// ================= 10. An out-of-invocation dependency never blocks
{
  let dispatched = 0;
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: [g("group-a", 100)],
    restart: false,
    concurrency: 1,
    // The issue declares a dependency on #7, which is not in this invocation.
    dependencies: planOrderingEdges([{ id: "group-a", issues: [100] }], { 100: [7] }).byGroup,
    runGroup: async () => {
      dispatched += 1;
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(dispatched === 1, "a dependency outside the invocation does not block dispatch");
  assert(summary.merged === 1, "the group merged normally");
}

// ======================= 11. A cycle parks all groups before any dispatch
{
  const started: number[] = [];
  const groups = [g("group-a", 100), g("group-b", 101), g("group-c", 102)];
  const plan = planOrderingEdges(
    groups.map((x) => ({ id: x.id, issues: x.issues })),
    { 100: [101], 101: [100] },
  );
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 3,
    dependencies: plan.byGroup,
    cyclic: plan.cyclic,
    runGroup: async (primary) => {
      started.push(primary);
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(
    !started.includes(100) && !started.includes(101),
    "neither group in the cycle was EVER dispatched — runGroup is not called for them",
  );
  for (const id of ["group-a", "group-b"]) {
    const e = summary.entries.find((x) => x.groupId === id);
    assert(
      e?.outcome === "parked" && /dependency-cycle/.test(e.reason ?? ""),
      `${id} parks with dependency-cycle`,
    );
  }
  assert(
    summary.entries.some((e) => e.groupId === "group-c" && e.outcome === "merged"),
    "the group outside the cycle runs normally",
  );
}

// ============ 12. A claim wait releases once the sibling reaches ANY terminal
{
  // The gap the spec names: the old loop only re-tested earlier-index
  // in-flight siblings and did not distinguish terminal states. A sibling
  // that PARKED still holds no claim — nothing is being edited any more.
  const started: number[] = [];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: [g("group-a", 100, ["src/x.ts"]), g("group-b", 101, ["src/x.ts"])],
    restart: false,
    concurrency: 2,
    runGroup: async (primary) => {
      started.push(primary);
      await new Promise((r) => setTimeout(r, primary === 100 ? 40 : 5));
      return { started: true };
    },
    // group-a parks (round-cap). group-b overlaps its paths, so it must wait
    // for a's SETTLEMENT — not for a merge that will never come.
    readStateFn: async (_r, issue) =>
      issue === 100
        ? ({
            schemaVersion: 1,
            issue: 100,
            // biome-ignore lint/suspicious/noExplicitAny: only the read fields matter
            pipelineState: { status: "handoff", currentStep: "lens-review", lastCompletedStep: "ci" } as any,
            eventLog: [
              { kind: "cap-hit", at: 1, cap: "round-cap", reviewRound: 3, nextStep: "handoff" },
            ] as any,
          } as unknown as WorkState)
        : mkState(issue, "merged"),
  });
  assert(started.includes(101), "the overlapping group ran after its sibling PARKED — a park releases the claim");
  assert(
    started.indexOf(101) > started.indexOf(100),
    "and it ran after, not alongside (the overlap gate still serialises)",
  );
  assert(
    summary.entries.some((e) => e.groupId === "group-b" && e.outcome === "merged"),
    "the waiting group is reported on its own merits, not as collateral",
  );
}

// ============ 13. A wait that outlasts its bound PARKS; it does not proceed
{
  // The explicit behaviour change the spec requires. Pre-#1101 the cap was
  // dropped and the group proceeded, on the theory the reactive check would
  // catch a real conflict — for an ordering edge that theory is backwards.
  const started: number[] = [];
  const groups = [g("group-a", 100), g("group-b", 101)];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 2,
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    // group-a hangs: runGroup never settles. group-b must not inherit the hang.
    deferCapMs: 60,
    runGroup: async (primary) => {
      started.push(primary);
      if (primary === 100) {
        await new Promise((r) => setTimeout(r, 400));
        return { started: true };
      }
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(!started.includes(101), "the dependent did NOT proceed past the cap");
  const b = summary.entries.find((e) => e.groupId === "group-b");
  assert(
    b?.outcome === "parked" && /dependency-timeout/.test(b.reason ?? ""),
    `the capped wait parks with dependency-timeout (got: ${b?.reason})`,
  );
  assert(
    !summary.notStarted.some((n) => n.includes("group-b")),
    "a group that waited and capped out is a PARK, not a never-reached group",
  );
}

// ============ 14. Empty extracted paths still wait — the plan-declared case
{
  // The root cause of the plan-time park: the overlap predicate answers "no
  // overlap" for an empty set, so a pair whose BODIES name no path ran
  // concurrently and `checkAndRegisterClaims` parked the loser at plan. Here
  // the queue cannot predict the collision from the bodies either, so the
  // ordering edge is the only signal — and it must hold the group back rather
  // than let the reactive check park it after a dispatch.
  const started: number[] = [];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: [g("group-a", 100, []), g("group-b", 101, [])],
    restart: false,
    concurrency: 2,
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    runGroup: async (primary) => {
      started.push(primary);
      await new Promise((r) => setTimeout(r, primary === 100 ? 40 : 5));
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  assert(
    started.indexOf(101) > started.indexOf(100),
    "an ordering edge holds the dependent even when BOTH groups extracted no paths (where the overlap predicate is blind)",
  );
  assert(summary.merged === 2, "and nothing parks when the dependency merges");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
