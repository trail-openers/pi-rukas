#!/usr/bin/env bun
/**
 * lean/machine — the `challenge` + `budget` edge, on its own (#1883).
 *
 * Split from `test-lean-machine.ts` for the 500-line gate (AGENTS.md §12), and
 * worth the split on its own merits: this edge is the one the epic changed, and
 * its claim is a PAIR — same destination as `challenge + none` AND the same
 * counters — which is easier to read away from the 100-neighborhood table test
 * than inside it.
 *
 * A challenge round that ran out of its own budget added nothing, so it is
 * `none` with a reason rather than a run failure: the contract the run holds was
 * written and proved by `specify`, and whether it HOLDS is `verify`'s question,
 * which still runs every frozen test. A round that did not converge says nothing
 * about the build, so it must not end it — the two runs this replaces were both
 * handed back after passing `specify` and `build`.
 *
 * Asserted across several counter combinations rather than the defaults: a
 * transition that also spent a build attempt or raised the draft flag would look
 * correct on the destination alone, and only the whole counter object shows it.
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

const COUNTER_VARIANTS = [
  INITIAL_COUNTERS,
  { ...INITIAL_COUNTERS, buildAttempts: MAX_BUILD_ATTEMPTS },
  { ...INITIAL_COUNTERS, buildAttempts: 1, draft: true },
  { ...INITIAL_COUNTERS, challengeDone: false, reviewDone: true, ciFixUsed: true },
] as const;

for (const counters of COUNTER_VARIANTS) {
  const label = JSON.stringify(counters);
  const stop = next(run("challenge", { counters }), { kind: "budget" });
  const none = next(run("challenge", { counters }), { kind: "none" });
  assert(
    stop.state === "verify",
    `challenge + budget goes to verify, not handback (${label})`,
  );
  assert(
    stop.state === none.state,
    `challenge + budget lands where challenge + none lands (${stop.state} vs ${none.state}, ${label})`,
  );
  assert(
    JSON.stringify(stop.counters) === JSON.stringify(none.counters),
    `challenge + budget leaves exactly the counters challenge + none leaves (${JSON.stringify(stop.counters)} vs ${JSON.stringify(none.counters)}, ${label})`,
  );
  assert(
    stop.counters.challengeDone === true,
    `challenge + budget spends the round, so no second challenge is offered (${label})`,
  );
  assert(
    stop.counters.buildAttempts === counters.buildAttempts,
    `challenge + budget bills no build attempt (${label})`,
  );
  assert(
    stop.counters.draft === counters.draft,
    `challenge + budget neither raises nor clears the draft marker (${label})`,
  );
}

// The counter pair is the load-bearing half. If the budget edge and the `none`
// edge ever drift — one of them billed a round, or one set a draft — the two
// comparisons above disagree, and this says so without a passing run in between.
const drifted = next(run("challenge"), { kind: "budget" });
assert(
  drifted.counters.buildAttempts === 0 && drifted.counters.draft === false,
  "from a fresh run the budget edge leaves every counter at its initial value",
);

process.exit(exit);
