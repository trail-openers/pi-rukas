#!/usr/bin/env bun
/**
 * #1101 (fixtures half) — the real 900/901 issue pair, and the two queue
 * invariants that only a whole-invocation run can show.
 *
 * Split out of `test-work-queue-ordering.ts` for AGENTS.md §12's 500-line cap.
 * What is here is the material that the ordering cases do not need and the
 * fixtures do: a pair read from disk, a group stranded behind a dependency that
 * can never merge, and a group the drain parks and re-tests.
 */
import { readFileSync } from "node:fs";
import { groupIssues } from "../src/work-driver-grouping.ts";
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

// ===== 15. The real 900/901 fixture pair produces a cross-group ordering edge
//
// `fixtures/issues/900.json` + `901.json` are the ORIGINAL issues this feature
// was built from, and the only pair in the repo that is genuinely TWO groups
// with an ordering edge between them: 901 declares `Depends-on: #900` (which R1
// would union) AND `Split: true` (which R3 pulls apart). Every other case in
// the ordering files hand-builds its groups, so without this section the
// fixtures are read by nothing and can rot into a body that declares no edge at
// all — a fixture that tests nothing is worse than no fixture, because the
// green suite keeps asserting against shapes nobody wrote. The fixture TEXT is
// therefore asserted directly, so an edit that drops the statement or the split
// marker fails loudly instead of quietly emptying the three assertions below.
{
  const read = (n: number) =>
    JSON.parse(
      readFileSync(`${import.meta.dirname}/fixtures/issues/${n}.json`, "utf8"),
    ) as { number: number; body: string };
  const a = read(900);
  const b = read(901);
  assert(a.number === 900 && b.number === 901, "the fixtures are the 900/901 pair");
  assert(/Depends-on: #900/.test(b.body), "901 declares a dependency on 900");
  assert(/Split:\s*true/.test(b.body), "901 carries the R3 split marker");
  const groupResult = groupIssues([900, 901], { 900: a.body, 901: b.body });
  const groupList = Object.values(groupResult.groups);
  assert(
    groupList.length === 2,
    `R1's union is overridden, so the pair is TWO groups — the only shape with a queue ordering question (got ${groupList.length})`,
  );
  const plan = planOrderingEdges(
    groupList.map((x) => ({ id: x.id, issues: x.issues })),
    groupResult.depsByIssue,
  );
  const depGroup = groupList.find((x) => x.issues[0] === 901);
  assert(
    plan.byGroup[depGroup?.id ?? ""]?.blockingGroupIds.length === 1 &&
      plan.byGroup[depGroup?.id ?? ""]?.blockingGroupIds[0] ===
        groupList.find((x) => x.issues[0] === 900)?.id,
    "the declared statement survives the split as one cross-group edge: 901's group waits for 900's",
  );
  assert(plan.cyclic.length === 0, "the pair is an edge, not a cycle — nothing parks pre-flight");

  // And the queue honours it: 901's `runGroup` is never invoked when 900 parks.
  const ran: number[] = [];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups: groupList,
    restart: false,
    concurrency: 2,
    dependencies: plan.byGroup,
    cyclic: plan.cyclic,
    runGroup: async (primary) => {
      ran.push(primary);
      return { started: true };
    },
    readStateFn: async (_r, issue) =>
      issue === 900 ? mkState(issue, "handoff") : mkState(issue, "merged"),
  });
  assert(!ran.includes(901), "with 900 parked, #901's runGroup is never invoked");
  assert(
    /cap dependency-parked:#900/.test(
      summary.entries.find((e) => e.issues.includes(901))?.reason ?? "",
    ),
    "and #901 parks naming #900 — the 901 deliverable, end to end",
  );
}

// ===== 16. A group stranded behind a parked dependency is still reported
//
// The drain re-tests the groups it parked, and a revive that dropped `entries`
// while leaving `resolved` stamped produced a group `stillWaiting` called
// finished (so every waiter retired), that `finish()` kept out of `notStarted`
// (because `resolved` says the queue answered for it), and that no entry lists
// either — the group disappeared from the operator's index entirely.
//
// The shape below is a real one and reaches the drain deliberately: group-c
// (#102) overlaps group-a's paths so it waits; group-b (#101) waits on group-a's
// merge; group-a parks, which releases c's claim wait AND strands b behind a
// dependency that can never merge. Whether b survives in the report depends on
// nothing but its marks moving together with its entry.
{
  const ran: number[] = [];
  const groups: IssueGroup[] = [
    g("group-a", 100, ["src/shared.ts"]),
    g("group-b", 101, []),
    g("group-c", 102, ["src/shared.ts"]),
  ];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    // K=2: one worker scans, the other ends in the drain and does the re-testing.
    concurrency: 2,
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    deferCapMs: 25,
    runGroup: async (primary) => {
      ran.push(primary);
      await new Promise((r) => setTimeout(r, 15));
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, issue === 100 ? "handoff" : "merged"),
  });
  const b = summary.entries.find((e) => e.groupId === "group-b");
  const listed = !!b || summary.notStarted.some((n) => n.includes("group-b"));
  assert(listed, "the group stranded behind a parked dependency is reported under one heading");
  assert(
    !(b && summary.notStarted.some((n) => n.includes("group-b"))),
    "and never under BOTH — the marks and the entry moved together",
  );
  assert(ran.includes(100) && ran.includes(102), "the two runnable groups both ran");
  assert(
    !ran.includes(101),
    "the group behind the never-merging dependency never dispatched (a park, not a wasted cycle)",
  );
}

// ===== 17. A queue-parked group is recorded once, and under one heading only
//
// Two routes can park the same group (the scan racing the drain, a cap racing a
// settle), and the pre-flight cycle pass can race the drain's park too. The
// duplicate-entry guard must be ALL-OR-NOTHING: the entry and the two marks
// (`settled`/`resolved`) move together, or a second route re-stamps "this group
// has answered" onto a group a revive has just cleared it from — and `finish()`
// then leaves it out of `notStarted` while no entry lists it either. The report
// is the observable face of that invariant: a group is listed exactly once, and
// under exactly one heading.
{
  const groups: IssueGroup[] = [g("group-a", 200), g("group-b", 201)];
  const plan = planOrderingEdges(
    groups.map((x) => ({ id: x.id, issues: x.issues })),
    { 201: [200, 200] },
  );
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 2,
    dependencies: plan.byGroup,
    cyclic: plan.cyclic,
    // group-a hangs past the cap, so group-b has every reason to be parked and
    // nothing resolves it: the pre-pass, the scan and the drain all have the
    // same group in reach.
    deferCapMs: 30,
    runGroup: async (primary) => {
      if (primary === 200) await new Promise((r) => setTimeout(r, 200));
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  const forB = summary.entries.filter((x) => x.groupId === "group-b");
  assert(forB.length === 1, `group-b is recorded exactly once (got ${forB.length})`);
  assert(
    forB[0]?.outcome === "parked" && /cap dependency-/.test(forB[0]?.reason ?? ""),
    `and it is a queue park naming the blocker (got: ${forB[0]?.reason})`,
  );
  assert(
    !summary.notStarted.some((n) => n.includes("group-b")),
    "a queue-parked group is not ALSO listed as never-reached (the all-or-nothing guard)",
  );
  assert(
    summary.entries.filter((x) => x.groupId === "group-a").length === 1,
    "the hung sibling is likewise recorded exactly once",
  );
}

// ===== 18. A revived group that gets parked AGAIN does not vanish (item 1)
//
// THE shape item 1 is about, and the only construction that reaches `revive`:
// group-b sits behind two blockers at once — an ordering edge on group-a and a
// predicted path collision with group-c.
//
//   1. The scan defers b (it is blocked on both).
//   2. group-a settles MERGED and group-c is still running, so the ordering
//      edge is satisfied and only the claim wait remains — which the drain's
//      cap-out parks as `dependency-timeout`.
//   3. group-c then settles. b is no longer blocked and still carries its park
//      entry, so the drain REVIVES it: entry + `settled` + `resolved` come down
//      together and a fresh cycle runs, which merges.
//
// Before the all-or-nothing guard, step 2's second park route (a cap racing the
// settle) re-stamped `resolved` while the entry was deduplicated away, and step
// 3's revive cleared only the entry — leaving a group `stillWaiting` called
// finished, that `finish()` kept out of `notStarted`, and that no entry listed.
// The disjunction below is the mutation detector: with the guard in place b
// appears exactly once; with the marks and the entry able to move independently
// it appears twice or not at all.
{
  const ran: number[] = [];
  const groups: IssueGroup[] = [
    g("group-a", 400, []),
    g("group-b", 401, ["src/b.ts"]),
    g("group-c", 402, ["src/b.ts"]),
  ];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    // K=3: one worker per group, so one of them is parked in the drain when the
    // blockers settle and can do the re-test that revives b.
    concurrency: 3,
    dependencies: { "group-b": { blockingGroupIds: ["group-a"] } },
    // Short enough that the claim wait on c actually caps out, long enough that
    // c settles first and clears it — the two routes racing on the same group.
    deferCapMs: 40,
    runGroup: async (primary) => {
      ran.push(primary);
      // a releases quickly; c holds long enough to cap b's claim wait, then
      // settles so the drain re-tests b and revives it.
      await new Promise((r) => setTimeout(r, primary === 402 ? 25 : 8));
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue, "merged"),
  });
  const forB = summary.entries.filter((x) => x.groupId === "group-b");
  const bInNotStarted = summary.notStarted.some((n) => n.includes("group-b"));
  assert(
    forB.length <= 1,
    `group-b is never recorded twice (got ${forB.length}) — the dedup guard and the marks are one decision`,
  );
  assert(
    !(forB.length === 1 && bInNotStarted),
    `and never under BOTH headings (entry=${forB.length}, notStarted=${bInNotStarted})`,
  );
  assert(
    forB.length === 1 || bInNotStarted,
    `so it appears at least once: entry=${forB.length}, notStarted=${bInNotStarted}`,
  );
  assert(ran.includes(401), "and the revived group's cycle actually ran (a park it outgrew is not a verdict)");
  assert(summary.merged === 3, `all three groups merged (merged=${summary.merged})`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
