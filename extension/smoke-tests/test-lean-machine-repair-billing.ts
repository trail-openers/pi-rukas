#!/usr/bin/env bun
/**
 * lean/machine — what a repair round costs (#2668).
 *
 * An attempt is a round DISPATCHED. The edge that ENTERS `build` is the edge that
 * dispatches a builder, so it is the only edge that bills one; the round that
 * corrects a frozen oracle dispatches an adversary instead. A run must not earn a
 * build round by reporting that its own contract is unsatisfiable, and the issue
 * says the same thing from the other side: the build a repair sends back keeps the
 * budgets the run already had, so the ONLY thing a repair round costs is its own
 * counter, charged once, on the way out.
 *
 * Every assertion here is made on BOTH arms of the switch. The off arm is the
 * release: a blocked build hands back and bills nothing. The on arm is the round:
 * entering it bills nothing, and leaving it for `build` bills one round and one
 * spent repair. An edge that is right on one arm and wrong on the other is the bug
 * shape this file exists for.
 */

import { MAX_BUILD_ATTEMPTS, next } from "../src/lean/machine.ts";
import { INITIAL_COUNTERS, type LeanRun, type LeanState } from "../src/lean/state.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const HEAD = "b".repeat(40);

function run(state: LeanState, over: Partial<LeanRun> = {}): LeanRun {
  return {
    schema: 1,
    issue: 1,
    version: "test",
    models: {},
    baseSha: "sha",
    branch: "b",
    state,
    counters: { ...INITIAL_COUNTERS },
    steps: [],
    ...over,
  };
}

const blocked = (counters: Partial<LeanRun["counters"]>, oracleRepair: boolean): LeanRun =>
  run("build", {
    counters: { ...INITIAL_COUNTERS, ...counters },
    ...(oracleRepair ? { oracleRepair: true } : {}),
  });

const blockedOutcome = {
  kind: "blocked",
  blockedBy: { "tests/AC1.test.sh": "cannot hold" },
  headBefore: HEAD,
};

// ── entering the round bills no build attempt, on either arm
for (const oracleRepair of [false, true]) {
  const arm = oracleRepair ? "on" : "off";
  for (const buildAttempts of [0, 1, MAX_BUILD_ATTEMPTS - 1, MAX_BUILD_ATTEMPTS]) {
    const moved = next(blocked({ buildAttempts }, oracleRepair), blockedOutcome);
    // Off arm: no round stamped, so the run hands back exactly as the release does.
    const expected = oracleRepair ? "repair" : "handback";
    assert(
      moved.state === expected,
      `build + blocked (${arm}) at ${buildAttempts} attempt(s) goes to ${expected} (got ${moved.state})`,
    );
    assert(
      moved.counters.buildAttempts === buildAttempts,
      `build + blocked (${arm}) charges no build attempt at ${buildAttempts} (got ${moved.counters.buildAttempts})`,
    );
    assert(
      moved.counters.repairsSpent === 0,
      `build + blocked (${arm}) charges no repair round on entry (got ${moved.counters.repairsSpent})`,
    );
  }
}

// ── the round's two exits each bill one build round AND exactly one repair
for (const kind of ["repaired", "refused"] as const) {
  const before = run("repair", {
    counters: { ...INITIAL_COUNTERS, buildAttempts: 1, repairsSpent: 0 },
    oracleRepair: true,
  });
  const moved = next(before, { kind });
  assert(
    moved.state === "build" && moved.counters.buildAttempts === 2,
    `repair + ${kind} → build and bills the one round the round dispatches (got ${moved.state}/${moved.counters.buildAttempts})`,
  );
  assert(
    moved.counters.repairsSpent === 1,
    `repair + ${kind} spends exactly one repair round (got ${moved.counters.repairsSpent})`,
  );
}

// ── one round per run: a spent round cannot be bought again
{
  // The gate that decides this is `repairRoundDue`, read off the RUN rather than
  // the environment, so the counter the exits write is the whole statement.
  const spent = blocked({ repairsSpent: 1 }, true);
  const moved = next(spent, blockedOutcome);
  assert(
    moved.state === "handback",
    `build + blocked with repairsSpent already 1 routes to handback (got ${moved.state})`,
  );
  assert(
    moved.counters.buildAttempts === spent.counters.buildAttempts,
    "and that handback bills no build attempt either",
  );
  // The counter half of the predicate is load-bearing: with the switch stamped on
  // but no round spent, the same run does get the round.
  const unspent = next(blocked({ repairsSpent: 0 }, true), blockedOutcome);
  assert(unspent.state === "repair", "and the same run with an unspent round gets the round");
}

// ── a run cannot reach the repair round past the build cap without a round of its own
{
  // Entering `repair` dispatches no builder, so the build cap cannot be spent by
  // the round's own entry. The cap still binds where it always did: an ordinary
  // blocked run with the switch off hands back whatever its counter says.
  const atCap = next(blocked({ buildAttempts: MAX_BUILD_ATTEMPTS }, false), blockedOutcome);
  assert(
    atCap.state === "handback" && atCap.counters.buildAttempts === MAX_BUILD_ATTEMPTS,
    `an off-arm blocked run at the cap hands back with its counter intact (got ${atCap.state}/${atCap.counters.buildAttempts})`,
  );
}

process.exit(exit);
