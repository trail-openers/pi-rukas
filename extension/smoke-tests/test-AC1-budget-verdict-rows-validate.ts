#!/usr/bin/env bun
/**
 * lean/step-budget — AC1 edge case: a clipped `dispatches` array must be one the
 * LOADER ACCEPTS, not merely one that is short enough.
 *
 * `budgetVerdictWithRows` currently clips with `rows.slice(-DISPATCHES_MAX_ROWS)`
 * alone. The three sibling surfaces named in AC1 all run the rows through the
 * engine's own validator FIRST (`validatedDispatches` in `error-outcome.ts` and
 * `review-errors.ts`), which drops a row the record may not carry. A step passes
 * the raw accumulated array here — `review.ts` hands over its `rows` accumulator
 * untouched — so one malformed row (a NaN duration, a runId `Number()` cannot
 * read) survives into `Outcome.dispatches`.
 *
 * The consequence is not a smaller record: `dispatchesProblem` REFUSES the whole
 * array over the cap and `assertRun` refuses the whole step, so `loadRun` throws
 * for the entire run and the run cannot be resumed at all. The frozen test drives
 * an over-cap array of well-formed rows, so it cannot see this.
 */

import { DISPATCHES_MAX_ROWS, FIX_RUN_ID } from "../src/lean/state-dispatches.ts";
import { budgetVerdictWithRows } from "../src/lean/step-budget.ts";
import type { DispatchUsageRow } from "../src/lean/step-budget.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";

const SELF = "test-AC1-budget-verdict-rows-validate.ts";
const { assert: rawAssert, failures } = makeAssert();
function assert(cond: boolean, msg: string): void {
  rawAssert(cond, `${SELF}: ${msg}`);
}

const USAGE = { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, turns: 4, cost: 0.5 };
const FIRED = { limit: "turns" as const, value: 30, used: 31 };

function row(i: number): DispatchUsageRow {
  return { role: `child-${String(i)}`, ms: i * 100, ok: true, usage: USAGE };
}

/** The tail is already full, so the bad row is the only one the clip can drop. */
function rowsWith(bad: DispatchUsageRow): DispatchUsageRow[] {
  const rows = Array.from({ length: DISPATCHES_MAX_ROWS }, (_, i) => row(i));
  rows.push(bad);
  return rows;
}

// ── (a) a row whose duration is not a measure ───────────────────────────────
// What a child that died mid-report leaves behind: `ms` never filled in.
const nanRows = rowsWith({ role: "child-bad", ms: Number.NaN, ok: true, usage: USAGE });
const a = budgetVerdictWithRows("build", FIRED, nanRows);
const aRows = a.dispatches ?? [];
assert(
  aRows.length <= DISPATCHES_MAX_ROWS,
  `precondition: the array is still clipped (${String(aRows.length)})`,
);
assert(
  aRows.every((r) => Number.isFinite(r.ms) && r.ms >= 0),
  `a row the loader's validator refuses (NaN \`ms\`) is dropped, not recorded (${JSON.stringify(aRows.map((r) => r.ms))})`,
);
assert(
  !aRows.some((r) => r.role === "child-bad"),
  `and the bad row specifically is not among them (${JSON.stringify(aRows.map((r) => r.role))})`,
);

// ── (b) a fixer row whose tree identity is not the shape `fixRunId` mints ───
// The exact drift this repo has been bitten by: the writer admits a composite
// suffix, the loader refuses it, and `review-log.ts` reads the field back.
assert(
  FIX_RUN_ID.test("1700000000000-AAAAAAAAAAAAAAAAAAAA") === false,
  "precondition: the engine's own grammar refuses this runId",
);
const b = budgetVerdictWithRows("build", FIRED, [
  ...Array.from({ length: DISPATCHES_MAX_ROWS }, (_, i) => row(i)),
  {
    role: "developer",
    ms: 9_000,
    ok: true,
    usage: USAGE,
    runId: "1700000000000-AAAAAAAAAAAAAAAAAAAA" as DispatchUsageRow["runId"],
  },
]);
const bRows = b.dispatches ?? [];
assert(
  bRows.every((r) => r.runId === undefined || FIX_RUN_ID.test(r.runId)),
  `a row whose \`runId\` the loader refuses is dropped rather than recorded (${JSON.stringify(bRows.map((r) => r.runId))})`,
);

// ── (c) the whole record must still read back ──────────────────────────────
// The observable cost: `assertRun` refuses an array carrying either row, so the
// run cannot be loaded. A clipped array is only useful if the loader takes it.
const { outcomeProblem } = await import("../src/lean/state-outcome.ts");
for (const [name, oc] of [
  ["NaN ms", a],
  ["malformed runId", b],
] as const) {
  assert(
    outcomeProblem(oc as unknown as Record<string, unknown>, "build") === undefined,
    `(${name}) the verdict the step built passes the loader's own check, so the durable record still loads (${String(outcomeProblem(oc as unknown as Record<string, unknown>, "build"))})`,
  );
}

process.exit(failures());
