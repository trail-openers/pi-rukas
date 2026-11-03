#!/usr/bin/env bun
/**
 * lean/step-budget — `budgetVerdictWithRows` clips its rows like every other
 * surface that reports them (#1967 AC1).
 *
 * The done path in `lean/review.ts` hands back `rows.slice(-DISPATCHES_MAX_ROWS)`;
 * `specify` clips its merged attempts and `error-outcome.ts` clips the throw path,
 * all with the validator's own bound. `budgetVerdictWithRows` had no clip, so a
 * stopped step could hand the engine a `dispatches` array longer than
 * `DISPATCHES_MAX_ROWS` — which `dispatchesProblem` refuses and
 * `validatedDispatches` therefore DROPS ENTIRELY. The failure is silent and
 * backwards: the budget-stopped round, the most expensive child in the run,
 * reports itself as having cost nothing.
 *
 * Drives the real exported entry point: 20 distinct rows go in, at most 16 come
 * out, and they are the 16 NEWEST (the tail), matching the done path rule.
 */

import { type Outcome } from "../src/lean/state.ts";
import { budgetVerdictWithRows, type DispatchUsageRow } from "../src/lean/step-budget.ts";
import { DISPATCHES_MAX_ROWS, dispatchesProblem } from "../src/lean/state-dispatches.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();
const FILE = "test-AC1-budget-rows-clipped.ts";

/** A row whose role and cost both encode its position, so order survives the call. */
function row(i: number): DispatchUsageRow {
  return {
    role: `developer-${String(i)}`,
    ms: i * 1_000,
    ok: true,
    usage: { input: i, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  };
}

const FIRED = { limit: "turns" as const, value: 40, used: 41 };

// The oversized input: more rows than the validator admits, newest last.
const OVER = DISPATCHES_MAX_ROWS + 4;
const rows = Array.from({ length: OVER }, (_, i) => row(i));

const verdict = budgetVerdictWithRows("build", FIRED, rows) as Outcome & {
  dispatches: DispatchUsageRow[];
};

assert(verdict.kind === "budget", "the verdict is still a budget verdict");
assert(
  verdict.reason === "build stopped: turns budget 40 exceeded (used 41)",
  "the budget sentence is unchanged by the clip",
);

const kept = verdict.dispatches;
assert(
  Array.isArray(kept) && kept.length <= DISPATCHES_MAX_ROWS,
  `at most ${String(DISPATCHES_MAX_ROWS)} rows survive, got ${String(kept?.length)}`,
);

// The kept rows are the TAIL of the input — the newest children, which is what
// the done path in review.ts keeps and what `specify`'s merge clips to.
const tail = rows.slice(-DISPATCHES_MAX_ROWS);
const sameAsTail =
  Array.isArray(kept) &&
  kept.length === tail.length &&
  kept.every((r, i) => r.role === tail[i].role && r.ms === tail[i].ms);
assert(sameAsTail, "the surviving rows are the newest ones (the tail), in order");

// A record nothing can load is not a cost report: the loader would drop the
// whole array, so the stopped round would bill zero. Assert through the
// validator the loader actually uses.
assert(
  dispatchesProblem(kept) === undefined,
  "the verdict's rows pass the validator a loader applies before summing them",
);

// The under-sized cases must keep working exactly as they do today.
const few = budgetVerdictWithRows("build", FIRED, rows.slice(0, 3)) as Outcome & {
  dispatches: DispatchUsageRow[];
};
assert(
  few.dispatches.length === 3 && few.dispatches[0].role === "developer-0",
  "a row set under the cap is passed through untouched",
);
const none = budgetVerdictWithRows("build", FIRED, []) as Outcome & { dispatches?: unknown };
assert(none.dispatches === undefined, "no rows means no dispatches field at all");

if (failures() !== 0) {
  console.error(
    `FAIL ${FILE}: budgetVerdictWithRows kept ${String(kept?.length)} of ${String(
      OVER,
    )} rows instead of clipping to the newest ${String(DISPATCHES_MAX_ROWS)}`,
  );
  process.exit(1);
}
console.log(`PASS ${FILE}`);
