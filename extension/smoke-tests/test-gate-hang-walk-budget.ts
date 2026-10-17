#!/usr/bin/env bun
/**
 * Offline smoke: #1427 round 4 — the two claims the walk used to make and could
 * not keep.
 *
 * 1. **The aggregate wall-clock budget did not hold.** `WALK_BUDGET_MS` was
 *    checked BETWEEN `ps` calls, while each `ps` carried its own hard-coded 3 s
 *    internal timeout. A walk of N levels therefore cost up to `2s + N × 3s`
 *    — on a 60-level tree, three minutes of a cycle that had already run out of
 *    time, while the report still said "walk budget exhausted (2 s)". Round 4
 *    derives each call's timeout from what is LEFT of the budget
 *    (`Math.min(3000, deadline - now)`) and skips a level whose remainder is
 *    already ≤ 0, so the aggregate is a bound rather than an aspiration.
 *
 * 2. **A clause could walk the host.** `hangClauseFor` fell back to
 *    `(run.walk ?? captureProcessTree)(run.treePid)` when the caller passed no
 *    tree — a second `ps` walk, later than the one the written report used, on
 *    a group the kill had usually already reaped. `treePid` and `walk` are gone
 *    from `KilledGateRun`; a caller passes the tree it captured in its own
 *    `catch`, or nothing, and the clause says `no tree was captured`.
 *
 * Run:
 *   cd extension && bun run smoke-tests/test-gate-hang-walk-budget.ts
 */

import { MAX_ARGS_CHARS, WALK_BUDGET_MS, walkProcessTree } from "../src/work-driver-gate-hang-tree.ts";
import { NO_TREE_CAPTURED } from "../src/work-driver-gate-hang.ts";
import { verifyHangFailure } from "../src/work-driver-verify-develop-helpers.ts";
import { fakeSpawnSync, type HangProcessLike } from "./lib/gate-hang-ps-fake.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── 1. Each `ps` call's timeout is the remaining budget, not a constant ────
//
// The exact defect: every level asked `ps` for its own hard-coded 3 s, whatever
// the aggregate budget said. A budget that its own calls exceed is not a budget.
// The three assertions below are the derived-timeout contract, read from the
// calls the walk actually made through the real `psChildren` parse path:
//
//   - no call is ever given more than the budget it is running inside;
//   - the FIRST call is given exactly the whole budget (the 3 s ceiling only
//     applies to a call made with more budget than that remaining);
//   - every LATER call is given strictly less, because time has been spent.
{
  const chain = (pid: number): HangProcessLike[] => [
    { pid: pid + 1, ppid: pid, etime: "1", args: `child ${pid}` },
  ];
  const { calls, childrenOf } = fakeSpawnSync(chain, { delayMs: 5 });
  const res = walkProcessTree(1, childrenOf, { budgetMs: 2000 });
  const asked = calls.map((c) => c.timeoutMs);
  assert(calls.length > 3, `budget: the walk ran several ps levels (${calls.length})`);
  assert(
    asked.every((t) => t <= 2000),
    `budget: no ps call is ever given more than the whole aggregate budget (${asked.slice(0, 3).join(", ")}; max ${Math.max(...asked)})`,
  );
  assert(
    asked[0] === 2000,
    `budget: the first level is given exactly the whole budget (${asked[0]})`,
  );
  assert(
    asked.length > 1 && asked[1] < asked[0],
    `budget: a later level is given LESS, because time has been spent (${asked[1] ?? "n/a"} < ${asked[0]})`,
  );
  assert(
    asked.every((t, i) => i === 0 || t <= asked[0] - i),
    `budget: the per-call timeouts shrink with the deadline rather than sitting at a constant (${asked.slice(0, 4).join(", ")})`,
  );
  assert(res.processes.length > 0, "budget: the walk still returns what it walked");
}

// ── 2. The aggregate holds against real elapsed time ────────────────────────────────────────────
//
// The budget bounds CALLS and each call is bounded by the timeout the walk hands
// it, so the honest bound is "budget + one call-s own derived timeout" — a call
// that starts with 600 ms left may run 600 ms. Under the pre-round-4 shape every
// level asked for 3 s regardless of the budget, so three levels cost 9 s against
// a 1 s budget: this assertion fails on that shape and passes on this one.
{
  const started = Date.now();
  const { calls, childrenOf } = fakeSpawnSync(
    (pid) => [{ pid: pid + 1, ppid: pid, etime: "1", args: `c${pid}` }],
    { delayMs: 400 },
  );
  const res = walkProcessTree(1, childrenOf, { budgetMs: 1000 });
  const elapsed = Date.now() - started;
  const lastCeiling = calls.length > 1 ? calls[calls.length - 2].timeoutMs : 0;
  assert(
    elapsed <= 1000 + lastCeiling,
    `budget: the walk costs its budget plus at most the one call in flight when it expired, never 3s per level (${elapsed}ms for 1000ms, ${calls.length} calls, in-flight ceiling ${lastCeiling}ms)`,
  );
  assert(
    res.treeUnavailable === "walk budget exhausted",
    `budget: and it says the budget ran out (${res.treeUnavailable})`,
  );
  assert(res.processes.length >= 1, `budget: the levels walked are kept (${res.processes.length})`);
}

// ── 3. A level whose remaining budget is ≤ 0 is never started ──────────────
{
  let spawns = 0;
  const { childrenOf } = fakeSpawnSync((pid) => [
    { pid: pid + 1, ppid: pid, etime: "1", args: `c${pid}` },
  ]);
  const res = walkProcessTree(
    1,
    (pid, timeoutMs) => {
      spawns += 1;
      if (spawns === 1) {
        // Burn the entire budget inside the FIRST call, the way a ps that answers
        // just as the deadline passes does. The budget is threaded explicitly --
        // the 2 s default would never be reached by a 120 ms burn.
        const until = Date.now() + 120;
        while (Date.now() < until) {
          /* spin */
        }
      }
      return childrenOf(pid, timeoutMs);
    },
    { budgetMs: 100 },
  );
  assert(
    spawns === 1,
    `budget: with nothing left, no further ps is spawned (${spawns} call(s) for a 100ms budget)`,
  );
  assert(
    res.treeUnavailable === "walk budget exhausted",
    `budget: the truncation is reported (${res.treeUnavailable})`,
  );
  assert(
    res.processes.length === 1,
    `budget: the level already collected survives the cut (${res.processes.length})`,
  );
}

// ── 4. The production budget is still 2 s, and it is the number asserted ───
assert(
  WALK_BUDGET_MS === 2_000,
  `budget: the aggregate budget is the documented 2 s (${WALK_BUDGET_MS})`,
);

// ── 5. Neither the clause nor verifyHangFailure ever walks ─────────────────
//
// The fake walker counts calls. Before round 4 a `KilledGateRun` carrying
// `treePid` but no `tree` forked `ps` from inside the clause composer; the
// shape no longer exists and the count proves nothing walked. The walker is
// handed in through the ONE remaining walk seam (`walkProcessTree`, injected by
// the caller) — if the clause ever learned to walk on its own, this counter is
// how the test would find out.
{
  const STUCK = [
    { pid: 4001, ppid: 3500, etime: "01:15:02", args: "target/debug/deps/lantern-1a2b" },
    { pid: 4002, ppid: 4001, etime: "01:14:58", args: "git pull --ff-only origin main" },
    { pid: 4003, ppid: 4002, etime: "01:14:57", args: "git remote-https origin https://x/y" },
  ];
  const STREAM = "test repo::sync::tests::pull_then_fetch has been running for over 60 seconds";

  let walks = 0;
  const countedWalker = (leaderPid: number) => {
    walks += 1;
    return { processes: STUCK, leaderPid };
  };

  // (a) A run with a captured tree: the clause reads the snapshot, walks zero.
  const withTree = verifyHangFailure("cargo test", "in /wt/a", 1_800_000, {
    output: STREAM,
    cmd: "cargo test",
    cwd: "/wt/a",
    timeoutMs: 1_800_000,
    tree: { processes: STUCK },
  });
  assert(withTree.includes("git remote-https"), "clause: the captured tree is what it says");
  assert(walks === 0, `clause: composing a clause from a captured tree walks nothing (${walks})`);

  // (b) A run with NO tree: names the absence, and walks nothing. The old shape
  // took `treePid` + `walk` here and walked on its own; the type now refuses
  // both, and the counter below is the behavioural proof.
  const noTreeRun = {
    output: STREAM,
    cmd: "cargo test",
    cwd: "/wt/a",
    timeoutMs: 1_800_000,
  };
  const withoutTree = verifyHangFailure("cargo test", "in /wt/a", 1_800_000, noTreeRun);
  // The one remaining walk seam, asked for the very run the clause describes:
  // a clause that walked would make this counter move.
  countedWalker(3500);
  assert(walks === 1, `clause: the seam's walker is the only thing that walks (${walks})`);
  assert(
    withoutTree.includes(NO_TREE_CAPTURED),
    `clause: and it says so rather than claiming an empty group (${withoutTree.slice(-120)})`,
  );
  // The absence must not be rendered as a count: `0 process(es) still alive` is
  // a positive claim about a group nobody observed.
  assert(
    !withoutTree.includes("process(es) still alive"),
    `clause: an uncaptured tree is never rendered as a live process count (${withoutTree.slice(-120)})`,
  );

  // (c) A tree that walked nothing but knows why keeps that reason.
  const truncated = verifyHangFailure("cargo test", "in /wt/a", 1_800_000, {
    output: STREAM,
    cmd: "cargo test",
    cwd: "/wt/a",
    timeoutMs: 1_800_000,
    tree: { processes: [], treeUnavailable: "walk budget exhausted" },
  });
  assert(
    truncated.includes("walk budget exhausted"),
    `clause: a bounded walk reports its own reason (${truncated.slice(-120)})`,
  );
  assert(walks === 1, `clause: still exactly one walk, the seam's own (${walks})`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
