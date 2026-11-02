#!/usr/bin/env bun
/**
 * #1967 AC1 — `budgetVerdictWithRows` must clip `dispatches` to the same bound
 * the `done` path of `lean/review.ts` applies.
 *
 * The budget verdict attaches the cost rows of every dispatch the step paid for.
 * A review round accumulates rows across rounds (six lens children plus a fixer
 * per round, `lensRows` / `dispatchUsageRow`), so a stopped round can hand back
 * far more rows than `DISPATCHES_MAX_ROWS`. The validator (`dispatchesProblem`
 * in `state-dispatches.ts`) REFUSES an over-long array, and the loader then
 * DROPS the step's cost rows entirely — silently under-billing the children that
 * cost the most — rather than reporting an over-long run.
 *
 * `review.ts`'s success path already guards against that with
 * `rows.slice(-DISPATCHES_MAX_ROWS)`; `budgetVerdictWithRows` attached `rows`
 * raw. So this drives the real entry point with 40 rows and asserts (a) the
 * count, (b) that the KEPT rows are the tail (the newest), and (c) that the
 * verdict is otherwise the same verdict `budgetVerdict` returns.
 *
 * Offline: pure function, no children, no git.
 */
import { DISPATCHES_MAX_ROWS } from "../src/lean/state-dispatches.ts";
import { dispatchesProblem } from "../src/lean/state-dispatches.ts";
import { budgetVerdict, budgetVerdictWithRows } from "../src/lean/step-budget.ts";
import type { BudgetFired, DispatchUsageRow } from "../src/lean/step-budget.ts";

const FILE = "test-AC1-budget-verdict-rows-cap.ts";
let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The rows one long review run accumulates — `ms` is the row's ordinal. */
function rows(n: number): DispatchUsageRow[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 7 === 6 ? "developer" : "code-review-specialist",
    ms: i,
    ok: true,
    usage: { input: i, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  }));
}

const FIRED: BudgetFired = { limit: "turns", value: 40, used: 41 };
const OVER = DISPATCHES_MAX_ROWS * 2 + 8;

const many = rows(OVER);
const verdict = budgetVerdictWithRows("review", FIRED, many);
const kept = verdict.dispatches ?? [];

assert(
  kept.length <= DISPATCHES_MAX_ROWS,
  `a budget verdict with ${String(OVER)} rows records at most ${String(DISPATCHES_MAX_ROWS)} (got ${String(kept.length)})`,
);
assert(
  kept.length === DISPATCHES_MAX_ROWS &&
    kept.every((r, i) => r.ms === OVER - DISPATCHES_MAX_ROWS + i),
  `the kept rows are the newest ${String(DISPATCHES_MAX_ROWS)} — the tail, same rule as review.ts's done path (got ms ${String(kept.map((r) => r.ms).join(","))})`,
);
// The cap must not turn a real record into one the loader rejects.
assert(
  dispatchesProblem(kept) === undefined,
  `the capped array passes the validator (got ${String(dispatchesProblem(kept))})`,
);
// Nothing else about the verdict changes.
const plain = budgetVerdict("review", FIRED);
assert(
  verdict.kind === plain.kind &&
    verdict.limit === plain.limit &&
    verdict.value === plain.value &&
    verdict.used === plain.used &&
    verdict.reason === plain.reason,
  `the sentence and trio match budgetVerdict for the same breach (got ${String(verdict.reason)})`,
);

// The rule is a cap, not a filter: a run inside the bound keeps every row.
const within = rows(DISPATCHES_MAX_ROWS);
const small = budgetVerdictWithRows("review", FIRED, within);
assert(
  (small.dispatches ?? []).length === DISPATCHES_MAX_ROWS &&
    (small.dispatches ?? []).every((r, i) => r.ms === i),
  `a run of exactly ${String(DISPATCHES_MAX_ROWS)} rows keeps all of them in order (got ${String((small.dispatches ?? []).length)})`,
);
assert(
  budgetVerdictWithRows("review", FIRED, []).dispatches === undefined,
  "no rows still means no dispatches field",
);

if (exit !== 0) {
  console.log(`FAIL ${FILE}: budgetVerdictWithRows does not cap dispatches to the tail`);
  process.exit(1);
}
process.exit(0);
