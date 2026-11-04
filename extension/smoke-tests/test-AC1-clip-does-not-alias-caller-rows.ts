#!/usr/bin/env bun
/**
 * #1967 AC1 (edge) — the clip must not hand back the caller's OWN row objects.
 *
 * The frozen AC1 test drives a budget stop with `OVER` distinct rows and judges
 * the length and the tail. It never asks what the returned rows ARE, and
 * `rows.slice(-DISPATCHES_MAX_ROWS)` copies the ARRAY but not its elements: every
 * row the verdict carries is the same object the step accumulated. That is not
 * cosmetic. `build.ts` and `challenge.ts` build a row with `dispatchUsageRow`,
 * keep it in their own `rows` array, and `specify-attempt.ts` returns that SAME
 * array as `dispatched` for the retry merge while its outcome carries the verdict
 * built from it; `review-git.ts` stamps `runId` onto a row after the row was
 * built and pushes it onto the caller's running total. Anything that normalises a
 * row it is about to persist therefore edits the child's live report and every
 * other holder of it, and the state file records the edit as what the child
 * reported — while `leanUsage` (`usage-sum.ts`) sums those numbers into the
 * per-role totals a host compares against the frozen driver's.
 *
 * Judged on the two facts a copy buys: the verdict's rows are not the caller's
 * objects, and a write through one verdict cannot reach the step's rows or a
 * second verdict built from the same dispatches.
 */

import { DISPATCHES_MAX_ROWS } from "../src/lean/state-outcome.ts";
import { budgetVerdictWithRows } from "../src/lean/step-budget.ts";
import type { BudgetFired, DispatchUsageRow } from "../src/lean/step-budget.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const FILE = "test-AC1-clip-does-not-alias-caller-rows.ts";

const FIRED: BudgetFired = { limit: "turns", value: 40, used: 41 };

/** One child the step paid for, with a `usage` object the step owns. */
function row(n: number): DispatchUsageRow {
  return {
    role: `child-${String(n)}`,
    ms: 1000 + n,
    ok: true,
    usage: { input: n, output: n, cacheRead: 0, cacheWrite: 0, cost: 0, turns: n },
  };
}

const rows = Array.from({ length: DISPATCHES_MAX_ROWS + 4 }, (_, i) => row(i));
const verdict = budgetVerdictWithRows("build", FIRED, rows);
const kept: DispatchUsageRow[] = (verdict as { dispatches?: DispatchUsageRow[] }).dispatches ?? [];

assert(
  kept.length === DISPATCHES_MAX_ROWS &&
    kept.every((r, i) => r.role === `child-${String(i + rows.length - DISPATCHES_MAX_ROWS)}`),
  `${FILE}: precondition — the verdict carries the ${String(DISPATCHES_MAX_ROWS)} newest rows, got ${String(kept.length)}`,
);
assert(
  kept.length === DISPATCHES_MAX_ROWS && kept.every((r) => !rows.some((orig) => orig === r)),
  `${FILE}: the clipped rows are COPIES, not the step's own row objects — ${String(
    kept.filter((r) => rows.includes(r)).length,
  )} of ${String(kept.length)} verdict rows are the very objects the caller still holds`,
);

// A write through the verdict — the normalisation a step or the engine does before
// persisting (`review-git.ts` stamps `runId` after the row was built; a re-derived
// `ms` is the other) — must not reach the dispatch the step is still holding.
const newestOriginal = rows[rows.length - 1];
const newestInVerdict = kept[kept.length - 1];
newestInVerdict.ms = 0;
newestInVerdict.ok = false;
newestInVerdict.usage.input = 999_999;

assert(
  newestOriginal.ms === 1000 + (rows.length - 1) &&
    newestOriginal.ok === true &&
    newestOriginal.usage.input === rows.length - 1,
  `${FILE}: writing to a verdict row does not rewrite the dispatch the step still holds (step's newest row is now ms=${String(newestOriginal.ms)}, ok=${String(newestOriginal.ok)}, usage.input=${String(newestOriginal.usage.input)})`,
);

// And not into a second verdict built from the same dispatches: `specify` builds
// its step outcome from the merged rows of BOTH attempts, so the same array
// reaches `budgetVerdictWithRows` twice and each record must price the children as
// they reported, not as an earlier record was edited.
const keptAgain: DispatchUsageRow[] =
  (budgetVerdictWithRows("build", FIRED, rows) as { dispatches?: DispatchUsageRow[] }).dispatches ??
  [];
assert(
  keptAgain.length === DISPATCHES_MAX_ROWS &&
    keptAgain.every((r, i) => r.usage.input === i + rows.length - DISPATCHES_MAX_ROWS),
  `${FILE}: a second verdict from the same dispatches still prices each child as reported, got ${JSON.stringify(keptAgain.map((r) => r.usage.input))}`,
);

process.exit(failures());
