#!/usr/bin/env bun
/**
 * lean/step-budget — the clip's TWO properties the row count alone does not
 * prove (#1967 AC1).
 *
 * The frozen case drives 20 rows in and counts 16 out. That arithmetic passes
 * for a clip that keeps a row `dispatchesProblem` REFUSES — one row whose usage
 * carries `1e999` survives `slice(-16)`, and the loader then drops the whole
 * array through `validatedDispatches`, so the budget-stopped round reports zero
 * cost: the exact symptom #1967 is about, invisible to a length assertion. It
 * also passes for `slice(0, N)`, which records the children the step did NOT
 * die on. And because the verdict is the run's durable cost record, the array it
 * carries must belong to the record: `slice` copies the ARRAY but not its rows,
 * so a caller that reuses or clears its row buffer after the step rewrote what
 * the run said it paid.
 *
 * Drives the real exported entry point; asserts what the record holds after the
 * loader rebuilds it, not how the clip is written.
 */

import { DISPATCHES_MAX_ROWS } from "../src/lean/state-dispatches.ts";
import type { Outcome } from "../src/lean/state.ts";
import { type DispatchUsageRow, budgetVerdictWithRows } from "../src/lean/step-budget.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();
const FILE = "test-AC1-budget-rows-finite-immutable.ts";

/** What `JSON.parse` makes of the largest number a JSON document may carry. */
const HUGE = JSON.parse("1e999") as number;

function row(i: number, input = 1): DispatchUsageRow {
  return {
    role: `lens-${String(i)}`,
    ms: i * 10,
    ok: false,
    usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  };
}

const FIRED = { limit: "tokens" as const, value: 50_000, used: 51_000 };

// ---- the ordering nobody tried: the clip must keep the TAIL, not the head
{
  // `ms` is the only field that tells a head from a tail once the rows went
  // through the loader, and `slice(0, N)` satisfies `length <= N` just as well
  // as `slice(-N)` while recording the WRONG children: the ones the stopped step
  // did not die on.
  const rows = Array.from({ length: DISPATCHES_MAX_ROWS + 6 }, (_, i) => ({
    ...row(i),
    ms: i,
  }));
  const verdict = budgetVerdictWithRows("build", FIRED, rows) as Outcome & {
    dispatches: DispatchUsageRow[];
  };
  const kept = verdict.dispatches;
  assert(
    kept.length === DISPATCHES_MAX_ROWS && kept[0].ms === 6 && kept[kept.length - 1].ms === 21,
    `the surviving rows are the newest ${String(DISPATCHES_MAX_ROWS)} — head and tail both satisfy a length bound (got ${String(kept.length)} rows, ms ${String(kept[0]?.ms)}..${String(kept[kept.length - 1]?.ms)})`,
  );
}
// ---- the value that is almost right: a row no validator can load, still kept
{
  // One poisoned row in a batch over the cap. `1e999` is a number, so a clip
  // that only counts does not see it; `dispatchesProblem` refuses it and
  // `validatedDispatches` then drops the array WHOLE, so the stopped step bills
  // zero for every child it paid for — the #1967 symptom, invisible to a count.
  const rows = Array.from({ length: DISPATCHES_MAX_ROWS + 4 }, (_, i) =>
    row(i, i === DISPATCHES_MAX_ROWS + 3 ? HUGE : 1),
  );
  const verdict = budgetVerdictWithRows("build", FIRED, rows) as Outcome & {
    dispatches?: DispatchUsageRow[];
  };
  const kept = verdict.dispatches ?? [];

  assert(
    kept.length <= DISPATCHES_MAX_ROWS,
    `the over-cap batch still clips to ${String(DISPATCHES_MAX_ROWS)} (got ${String(kept.length)})`,
  );
  const nonFinite = kept
    .flatMap((r) => [r.ms, ...Object.values(r.usage)])
    .filter((n) => !Number.isFinite(n));
  assert(
    nonFinite.length === 0,
    `every number the verdict hands the loader is finite — one refused row costs the whole array its billing (found ${String(nonFinite.length)} non-finite)`,
  );
}

// ---- the record is the run's, not the caller's
{
  const rows = Array.from({ length: DISPATCHES_MAX_ROWS + 4 }, (_, i) => row(i));
  const verdict = budgetVerdictWithRows("build", FIRED, rows) as Outcome & {
    dispatches: DispatchUsageRow[];
  };
  const kept = verdict.dispatches;
  assert(
    kept.length === DISPATCHES_MAX_ROWS,
    `a clean over-cap batch clips (got ${String(kept.length)})`,
  );
  assert(
    Object.isFrozen(kept) && Object.isFrozen(kept[0]),
    "the cost rows of a durable record are frozen, so nothing rewrites what the run said it paid",
  );
  assert(
    !(rows as unknown[]).includes(kept[0]),
    "the rows the verdict reports are its own, so a caller that reuses or clears its row buffer after the fact cannot rewrite the record",
  );

  // And the record must still read as it did: a frozen array whose rows a
  // caller can still edit documents nothing.
  let drifted = false;
  try {
    (kept as { ms: number }[])[0].ms = 99;
    (verdict as { dispatches?: unknown }).dispatches = "not a cost record";
    drifted = true;
  } catch {
    // refused — what a durable record owes
  }
  assert(!drifted, "a built verdict cannot be rewritten after the fact");
}

if (failures() !== 0) {
  console.error(
    `FAIL ${FILE}: budgetVerdictWithRows clips rows but does not make the record it clips a loadable, immutable one`,
  );
  process.exit(1);
}
console.log(`PASS ${FILE}`);
