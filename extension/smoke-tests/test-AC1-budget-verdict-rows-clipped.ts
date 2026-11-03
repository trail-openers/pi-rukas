#!/usr/bin/env bun
/**
 * lean/step-budget — `budgetVerdictWithRows` clips its rows to
 * `DISPATCHES_MAX_ROWS`, keeping the TAIL (#1967).
 *
 * Every other surface that hands dispatch rows to the engine already applies
 * that rule: the `done`/`fixed` return in `review.ts`, `ReviewInfraError`'s
 * constructor, `errorOutcome`, and `specify`'s `mergedRows` — all
 * `rows.slice(-DISPATCHES_MAX_ROWS)`. `budgetVerdictWithRows` was the one arm
 * that did not, so a step whose children accumulated past the validator's cap
 * (the `challenge` round folds every lens child of every round into one `rows`)
 * returned a `dispatches` array `dispatchesProblem` refuses — and the loader
 * does not reject such a record, it DROPS the whole `dispatches` field,
 * silently un-billing the run's most expensive children on exactly the path
 * (an over-budget round) where the cost matters most.
 *
 * The tail is kept because rows arrive in dispatch order: the child that ran
 * last is the one that decided the step.
 *
 * Real entry point, real validator, no child spawned, no token spent.
 */

import { errorOutcome } from "../src/lean/error-outcome.ts";
import { DISPATCHES_MAX_ROWS } from "../src/lean/state-outcome.ts";
import { budgetVerdictWithRows } from "../src/lean/step-budget.ts";
import type { DispatchUsageRow } from "../src/lean/step-budget.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const SELF = "test-AC1-budget-verdict-rows-clipped.ts";
const { assert: rawAssert, failures } = makeAssert();

/** Every failure line names this file, so a red run is attributable. */
function assert(cond: boolean, msg: string): void {
  rawAssert(cond, `${SELF}: ${msg}`);
}

const USAGE = { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, turns: 4, cost: 0.5 };

/** One row, distinguishable by `role`, so the kept window can be identified. */
function row(i: number): DispatchUsageRow {
  return { role: `child-${String(i)}`, ms: i * 100, ok: true, usage: USAGE };
}

/** More rows than the cap, in dispatch order — a late challenge round's fold. */
const OVER = Array.from({ length: DISPATCHES_MAX_ROWS + 5 }, (_, i) => row(i));

/** The fired ceiling, as `readDispatched` leaves it on a stopped child. */
const FIRED = { limit: "turns" as const, value: 30, used: 31 };

const verdict = budgetVerdictWithRows("challenge", FIRED, OVER);

assert(
  verdict.kind === "budget" && Array.isArray(verdict.dispatches),
  `the rows ride on the budget verdict (kind ${verdict.kind})`,
);

const rows = verdict.dispatches ?? [];
assert(
  rows.length <= DISPATCHES_MAX_ROWS,
  `at most ${String(DISPATCHES_MAX_ROWS)} rows come back, got ${String(rows.length)}`,
);
assert(
  rows[0]?.role === OVER[5]?.role,
  `the kept window starts at the oldest row still inside the cap: first is ${String(rows[0]?.role)}, expected ${String(OVER[5]?.role)}`,
);
assert(
  rows.at(-1)?.role === OVER.at(-1)?.role,
  `the child that decided the step is among them: last is ${String(rows.at(-1)?.role)}, expected ${String(OVER.at(-1)?.role)}`,
);
assert(
  verdict.reason === "challenge stopped: turns budget 30 exceeded (used 31)",
  `the budget sentence is unchanged (${verdict.reason})`,
);

// The bound is the LOADER's, so it is asserted with the loader's own code: an
// over-cap array is what `errorOutcome` clips before handing rows to the record,
// and the two paths must now agree on one number.
const thrown = Object.assign(new Error("the challenge child died"), {
  dispatches: OVER,
});
const fromThrow = errorOutcome("challenge", thrown).dispatches ?? [];
assert(
  rows.length === fromThrow.length && rows[0]?.role === fromThrow[0]?.role,
  `the budget verdict and the throw path keep the same ${String(fromThrow.length)} rows (${String(rows.length)}, first ${String(rows[0]?.role)} vs ${String(fromThrow[0]?.role)})`,
);

// The empty case keeps its old shape: no rows, no `dispatches` field at all.
const empty = budgetVerdictWithRows("challenge", FIRED, []);
assert(empty.kind === "budget" && empty.dispatches === undefined, "no rows, no dispatches field");

process.exit(failures());
