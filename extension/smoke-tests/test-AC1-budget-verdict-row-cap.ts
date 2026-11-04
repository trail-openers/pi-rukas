#!/usr/bin/env bun
/**
 * #1967 AC1 — `budgetVerdictWithRows` must clip its rows to
 * `DISPATCHES_MAX_ROWS`, keeping the NEWEST (the tail) — the same rule the done
 * path in `lean/review.ts` applies through `rows.slice(-DISPATCHES_MAX_ROWS)`.
 *
 * The bug: the seam spread the caller's rows straight onto the verdict with no
 * bound of its own. A stopped round can hand it more than the validator's cap
 * (a six-lens round alone is six rows; a round plus its fixers and a re-review
 * is more), and `dispatchesProblem` then returns
 * "outcome dispatches must hold at most 16 rows" for the WHOLE array — so the
 * cost of the child the budget killed is dropped from the durable record and
 * from `usage.byRole`, and the run reports a stopped round that cost nothing.
 *
 * Offline: pure seam, nothing spawned, no temp repo.
 */
import { budgetVerdictWithRows, type DispatchUsageRow } from "../src/lean/step-budget.ts";
import { DISPATCHES_MAX_ROWS } from "../src/lean/state-outcome.ts";
import { dispatchesProblem } from "../src/lean/state-dispatches.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`ok — ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** One child the step paid for, distinguishable by its wall clock. */
function row(n: number): DispatchUsageRow {
  return {
    role: `role-${String(n)}`,
    ms: n * 1000,
    ok: true,
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  };
}

const OVER = DISPATCHES_MAX_ROWS + 6;
const rows = Array.from({ length: OVER }, (_, i) => row(i + 1));
const fired = { limit: "minutes" as const, value: 20, used: 21 };

const verdict = budgetVerdictWithRows("build", fired, rows);

// (1) the criterion itself: the verdict carries at most the cap, and never the
// rows the done path would have evicted.
const carried = verdict.dispatches ?? [];
assert(
  carried.length <= DISPATCHES_MAX_ROWS,
  `the verdict carries at most DISPATCHES_MAX_ROWS (${String(DISPATCHES_MAX_ROWS)}) rows, got ${String(carried.length)}`,
);
const tail = rows.slice(-DISPATCHES_MAX_ROWS);
assert(
  JSON.stringify(carried.map((r) => r.ms)) === JSON.stringify(tail.map((r) => r.ms)),
  `the rows kept are the NEWEST ${String(DISPATCHES_MAX_ROWS)} — the tail, as the done path in review.ts keeps (got ${JSON.stringify(carried.map((r) => r.ms))})`,
);
assert(
  !carried.some((r) => r.ms === 1000),
  "the oldest row — the one the tail rule evicts — is not on the record",
);

// (2) the reason the cap exists, asserted on the durable-record validator: a
// verdict this seam produced must be a record the loader accepts. Before the
// fix the array is over the cap and the validator refuses ALL of it, so the
// stopped round's cost vanishes instead of being billed.
const problem = dispatchesProblem(verdict.dispatches);
assert(
  problem === undefined,
  `the verdict's dispatches pass the durable-record validator (got ${JSON.stringify(problem)})`,
);

// (3) the same sentence the unbounded verdict would have said, unchanged.
assert(
  verdict.kind === "budget" && /build stopped: minutes budget 20 exceeded \(used 21\)/.test(verdict.reason ?? ""),
  `the clipping does not change the budget sentence (${String(verdict.kind)} / ${String(verdict.reason)})`,
);

if (exit !== 0) {
  console.log(
    "FAIL test-AC1-budget-verdict-row-cap.ts: budgetVerdictWithRows does not clip to DISPATCHES_MAX_ROWS keeping the tail",
  );
}
process.exit(exit);
