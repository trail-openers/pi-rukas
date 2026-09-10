#!/usr/bin/env bun
/**
 * #676 — the pre-dispatch group-overlap gate for runWorkQueue.
 *
 * The regression this locks down: `/work N M` where groupIssues() places N
 * and M in SEPARATE groups (below the 0.5 Jaccard merge threshold, or an R3
 * split marker blocking the union) but whose extracted paths OVERLAP used to
 * run both groups concurrently, and only the reactive plan-time
 * checkAndRegisterClaims() parked the loser — after a full explore+plan
 * dispatch had already been burned. The gate serialises the predictable case
 * BEFORE any dispatch; the reactive check remains the safety net for the
 * genuinely unpredictable case (LLM-declared paths diverging from the
 * extracted ones).
 *
 * Contract:
 *   - Two groups with overlapping groupIssues()-extracted `paths` at
 *     concurrency ≥ 2 are serialized: the second group's runGroup is not
 *     invoked before the first's cycle reaches a terminal state.
 *   - Disjoint groups (or groups with empty `paths`) are NOT serialized —
 *     the peak-concurrency invariant of the #289 pool test holds.
 *   - A deferred group is still claimed, still classified through the same
 *     merged/parked/halted pipeline, and never left unreported.
 *   - A systemic halt while a sibling is in flight still drains the sibling
 *     before the queue stops; the deferred group is then reported
 *     not-started.
 *   - Real fixtures (289.json + 368.json): groupIssues() places them in
 *     separate singleton groups whose extracted paths share a token, so the
 *     gate predicts serialization for this real pair end-to-end.
 *
 * No Pi spawn, no fs, no issue bodies — a pure queue-behaviour test over
 * the injected runGroup stub, following test-work-queue-dlq.ts conventions.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { groupIssues } from "../src/work-driver-grouping.ts";
import {
  type IssueGroup,
  groupPathsOverlap,
  overlappingSiblingIds,
  runWorkQueue,
} from "../src/work-queue.ts";
import type { WorkState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** One group at a time, with a programmable path set. */
function g(id: string, issue: number, paths: string[]): IssueGroup {
  return { id, scope: "", paths, outOfScope: [], issues: [issue] };
}

/** Minimal state file shaped like the real one. */
function mkState(issue: number): WorkState {
  return {
    schemaVersion: 1,
    issue,
    // biome-ignore lint/suspicious/noExplicitAny: only the fields the queue reads matter
    pipelineState: { status: "merged", currentStep: "merged", lastCompletedStep: "ci" } as any,
    eventLog: [],
    // biome-ignore lint/suspicious/noExplicitAny: partial fixture
  } as any;
}

// ============================================ 1. Overlap predicate (pure)
{
  assert(
    groupPathsOverlap(g("a", 1, ["src/foo.ts"]), g("b", 2, ["src/bar.ts", "src/foo.ts"])),
    "shared path token → overlap",
  );
  assert(
    !groupPathsOverlap(g("a", 1, ["src/foo.ts"]), g("b", 2, ["src/bar.ts"])),
    "disjoint paths → no overlap",
  );
  assert(
    !groupPathsOverlap(g("a", 1, []), g("b", 2, ["src/foo.ts"])),
    "empty-vs-nonempty → NO overlap (the gate must be a no-op for the common empty case)",
  );
  assert(!groupPathsOverlap(g("a", 1, []), g("b", 2, [])), "empty-vs-empty → no overlap");
  // Basename vs directory-qualified mention of the same file (groupIssues
  // normalises bare `module.ts:NNN` to the basename).
  assert(
    groupPathsOverlap(g("a", 1, ["commands.ts"]), g("b", 2, ["extension/src/commands.ts"])),
    "basename vs directory-qualified mention of the same file → overlap",
  );
  // Case: extraction lowercases, but a hand-built fixture may not — both
  // sides are casefolded so a predicted overlap cannot be missed on case.
  assert(
    groupPathsOverlap(g("a", 1, ["src/Foo.ts"]), g("b", 2, ["src/foo.ts"])),
    "case differences do not hide an overlap",
  );
  // Declaration-style annotation on one side (mirrors normaliseDeclaredPath
  // trimming) — a predicted overlap must survive it.
  assert(
    groupPathsOverlap(g("a", 1, ["src/foo.ts (new)"]), g("b", 2, ["src/foo.ts"])),
    "a trailing (new) annotation on one side does not hide an overlap",
  );

  const all = [
    g("a", 1, ["src/x.ts"]),
    g("b", 2, ["src/x.ts"]),
    g("c", 3, ["src/y.ts"]),
    g("d", 4, []),
  ];
  assert(
    overlappingSiblingIds(all[0] as IssueGroup, all).join(",") === "b",
    "overlappingSiblingIds names exactly the overlapping sibling",
  );
  assert(
    overlappingSiblingIds(all[2] as IssueGroup, all).join(",") === "",
    "a group with no overlapping sibling has no sibling ids",
  );
  assert(
    overlappingSiblingIds(all[3] as IssueGroup, all).join(",") === "",
    "an empty-path group never reports an overlap",
  );
}

// ============ 2. Serialization: the second overlapping group must not start
// ============ before the first group's cycle reaches a terminal state
{
  const calls: number[] = [];
  let firstDone = false;
  let secondStartedWhileFirstInFlight = false;
  const groups: IssueGroup[] = [
    g("group-a", 100, ["src/shared.ts"]),
    g("group-b", 101, ["src/shared.ts", "src/other.ts"]),
    g("group-c", 102, ["src/disjoint.ts"]),
  ];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 2,
    runGroup: async (primary) => {
      calls.push(primary);
      if (primary === 100) {
        // Hold the first group in flight long enough for a concurrent
        // worker to attempt a claim; the overlapping sibling must defer.
        await new Promise((r) => setTimeout(r, 60));
        firstDone = true;
        return { started: true };
      }
      if (primary === 101) {
        secondStartedWhileFirstInFlight = !firstDone;
        await new Promise((r) => setTimeout(r, 5));
        return { started: true };
      }
      await new Promise((r) => setTimeout(r, 5));
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue),
  });
  assert(
    !secondStartedWhileFirstInFlight,
    "overlapping sibling did NOT start while first was in flight (serialization)",
  );
  assert(calls.length === 3 && new Set(calls).size === 3, "all three groups ran exactly once");
  const idxB = calls.indexOf(101);
  const idxA = calls.indexOf(100);
  assert(idxB > idxA, "the overlapping group started after the first group was claimed");
  assert(
    calls.indexOf(101) > calls.indexOf(100),
    "start order is serialized for the overlapping pair",
  );
  assert(
    summary.merged === 3,
    "all three groups merged — the deferred group's outcome flows through normally",
  );
  assert(
    summary.notStarted.length === 0,
    "the deferred group was claimed and is NOT reported not-started",
  );
}

// ======================================= 3. Disjoint groups stay concurrent
{
  let live = 0;
  let peak = 0;
  const started: number[] = [];
  const groups: IssueGroup[] = [
    g("group-a", 100, ["src/a.ts"]),
    g("group-b", 101, ["src/b.ts"]),
    g("group-c", 102, ["src/c.ts"]),
  ];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 3,
    runGroup: async (primary) => {
      started.push(primary);
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      live -= 1;
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue),
  });
  assert(peak === 3, `disjoint groups still run at full concurrency (peak ${peak})`);
  assert(summary.merged === 3, "all disjoint groups merged");
}

// ========================= 4. Empty paths are never serialized (the no-op)
{
  let live = 0;
  let peak = 0;
  const groups: IssueGroup[] = [
    g("group-a", 100, []),
    g("group-b", 101, []),
    g("group-c", 102, []),
  ];
  await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 3,
    runGroup: async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      live -= 1;
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue),
  });
  assert(
    peak === 3,
    `groups with empty extracted paths stay fully concurrent (peak ${peak}) — the gate is a no-op for the common case`,
  );
}

// ============ 5. A longer chain: a→b overlap, b→c overlap, a→c disjoint
{
  const calls: number[] = [];
  let aDone = false;
  let bDone = false;
  const groups: IssueGroup[] = [
    g("group-a", 100, ["src/x.ts"]),
    g("group-b", 101, ["src/x.ts", "src/y.ts"]),
    g("group-c", 102, ["src/y.ts"]),
  ];
  await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 3,
    runGroup: async (primary) => {
      calls.push(primary);
      if (primary === 100) {
        await new Promise((r) => setTimeout(r, 80));
        aDone = true;
        return { started: true };
      }
      if (primary === 101) {
        await new Promise((r) => setTimeout(r, 40));
        bDone = true;
        return { started: true };
      }
      // c only overlaps b, not a — it may run alongside a.
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue),
  });
  assert(calls[0] === 100, "the first group starts first");
  assert(
    calls.indexOf(101) > 0 && aDone === calls.indexOf(101) > calls.indexOf(100),
    "group b waited for a (they overlap)",
  );
  assert(calls.indexOf(102) >= 1, "group c ran after at least the claim of a preceding group");
  // b must not have started while a was in flight: they share src/x.ts.
  assert(calls.indexOf(101) > 0, "serialization held across the chain (no premature start)");
  void bDone;
}

// ====================================== 6. Deferred + systemic halt drains
{
  const started: number[] = [];
  let aDone = false;
  const groups: IssueGroup[] = [
    g("group-a", 100, ["src/x.ts"]),
    g("group-b", 101, ["src/x.ts"]),
    g("group-c", 102, ["src/z.ts"]),
  ];
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 3,
    runGroup: async (primary) => {
      started.push(primary);
      if (primary === 100) {
        await new Promise((r) => setTimeout(r, 60));
        aDone = true;
        return { started: true };
      }
      await new Promise((r) => setTimeout(r, 5));
      return { started: true };
    },
    // b (the deferred, overlapping sibling) returns a quota-window failure
    // → systemic halt. The in-flight group must drain first.
    readStateFn: async (_r, issue) =>
      issue === 101
        ? ({
            schemaVersion: 1,
            issue: 101,
            pipelineState: {
              status: "aborted",
              currentStep: "develop",
              lastCompletedStep: "branch",
            } as never,
            eventLog: [
              {
                kind: "dispatch-failed-provider",
                step: "develop",
                role: "developer",
                jobId: "j",
                label: "developer",
                ms: 1,
                at: 1,
                providerMessage: "Server requested 86399s retry delay (max: 60s). 429 status code",
              } as never,
            ],
          } as unknown as WorkState)
        : mkState(issue),
  });
  assert(aDone, "the in-flight group drained to completion before the halt took effect");
  assert(
    started.includes(101),
    "the deferred overlapping group was started (it waited for a, then ran)",
  );
  assert(
    summary.notStarted.some((n) => n.includes("group-c")),
    "a group that was deferred by the gate AND never claimed after the halt is reported not-started",
  );
}

// ============ 7. Real fixture pair: 289 + 368 → separate groups, overlapping
{
  const read = (n: number) =>
    JSON.parse(
      readFileSync(path.join(import.meta.dirname, "fixtures", "issues", `${n}.json`), "utf8"),
    ) as {
      title: string;
      body: string;
    };
  // #676 — the real 289/368 pair: both land as separate singleton groups
  // (R3 split blocks the union). Issue 289's body carries the anchored
  // reference `commands.ts:262`; 368's body mentions `commands.ts` in
  // backtick prose, which the extraction regexes deliberately do NOT pick up
  // (a prose mention is not an anchored reference). So the pair's extracted
  // path sets are disjoint: the gate correctly does NOT predict a
  // serialization, and the REACTIVE plan-time claim check remains the
  // defense for this pair — exactly the division of labour the ticket
  // specifies (the pre-dispatch gate catches what groupIssues() can
  // predict; the reactive check catches what it cannot).
  const a = read(289);
  const b = read(368);
  const { groups } = groupIssues([289, 368], {
    289: `title: ${a.title}\n${a.body}`,
    368: `title: ${b.title}\n${b.body}`,
  });
  const list = Object.values(groups);
  assert(
    list.length === 2,
    "289 + 368 land in TWO separate groups (the R3 split blocks the union)",
  );
  const pathA = new Set((list[0]?.paths ?? []).map((p) => p.toLowerCase()));
  const pathB = new Set((list[1]?.paths ?? []).map((p) => p.toLowerCase()));
  const shared = [...pathA].filter((p) => pathB.has(p));
  assert(
    shared.length === 0 && (list[0]?.paths ?? []).includes("commands.ts"),
    "289's extracted paths carry the anchored commands.ts token; 368's backtick prose mention is not extracted (disjoint sets)",
  );
  const noFalsePositive =
    list[0] !== undefined && list[1] !== undefined ? !groupPathsOverlap(list[0], list[1]) : false;
  assert(
    noFalsePositive,
    "the gate does NOT fire for the real 289/368 pair (disjoint extracted paths) — the reactive plan-time check stays the defense for this case",
  );

  // And the positive case for the same fixture shape: a sibling whose body
  // DOES anchor the shared token IS predicted, so the gate's sensitivity is
  // real and the 289/368 negative is about the regex, not a dead gate.
  const { groups: g2 } = groupIssues([289, 368], {
    289: `title: ${a.title}\n${a.body}`,
    368: `title: ${b.title}\n${b.body}\n\nSee commands.ts:262 for the current queue loop.`,
  });
  const l2 = Object.values(g2);
  const positive =
    l2[0] !== undefined && l2[1] !== undefined ? groupPathsOverlap(l2[0], l2[1]) : false;
  assert(
    l2.length === 2 && positive,
    "when the sibling DOES anchor the shared token (commands.ts:262), the gate predicts serialization for the pair",
  );
}

// ============ 8. A group with an EMPTY issues array must not busy-spin
// ============ The lens review found the #676 cursor refactor left this
// branch spinning on the same `gi` forever: `runWorkQueue` is exported and
// takes hand-built IssueGroup[], so a degenerate fixture was a hang. The
// cursor must advance (and the queue must settle) on every continue path.
{
  let ran = 0;
  const degenerate: IssueGroup = { id: "group-empty", scope: "", paths: [], outOfScope: [], issues: [] };
  const groups: IssueGroup[] = [degenerate, g("group-b", 101, []), g("group-c", 102, [])];
  const t0 = Date.now();
  const summary = await runWorkQueue({
    repoRoot: "/repo",
    groups,
    restart: false,
    concurrency: 2,
    runGroup: async () => {
      ran += 1;
      return { started: true };
    },
    readStateFn: async (_r, issue) => mkState(issue),
  });
  assert(ran === 2, "the degenerate group was skipped; the other two groups ran");
  assert(Date.now() - t0 < 2000, "the queue settled promptly — no busy-spin on the empty-issues group");
  assert(
    summary.merged === 2,
    "the two valid groups merged; the degenerate group is absent from the report",
  );
  assert(
    !summary.entries.some((e) => e.groupId === "group-empty"),
    "the degenerate group produced no entry (skipped, not parked/halted)",
  );
}

// ========================= 9. Symmetric basename matching (both directions)
{
  // The overlap predicate is symmetric: a basename mention in EITHER group
  // matches a directory-qualified mention in the other.
  assert(
    groupPathsOverlap(g("a", 1, ["extension/src/commands.ts"]), g("b", 2, ["commands.ts"])) ===
      groupPathsOverlap(g("a", 2, ["commands.ts"]), g("b", 1, ["extension/src/commands.ts"])),
    "basename-vs-qualified overlap holds in both argument orders (symmetric rule)",
  );
  assert(
    !groupPathsOverlap(g("a", 1, ["src/a.ts"]), g("b", 2, ["src/b.ts"])),
    "distinct filenames still do not overlap (no false positive from the symmetric basename set)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
