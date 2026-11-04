#!/usr/bin/env bun
/**
 * #1967 AC1 — `budgetVerdictWithRows` must cap `dispatches` the way every other
 * row-carrying outcome in the lean engine does.
 *
 * The done path (`review-pass.ts`) and both throw paths (`review-errors.ts`,
 * `error-outcome.ts`) clip with `rows.slice(-DISPATCHES_MAX_ROWS)`, so the
 * newest rows survive and no outcome is ever over-long. `budgetVerdictWithRows`
 * attaches its rows raw, and `dispatchesProblem` in `state-dispatches.ts`
 * refuses ANY array longer than `DISPATCHES_MAX_ROWS` outright — so a budget
 * stop on a step whose rounds dispatched more children than the cap (the review
 * step's lens rounds do exactly that) produces a verdict the durable record
 * cannot hold.
 *
 * Driven at the real entry point with more rows than the cap, both directions:
 * the cap is enforced, and the KEEPING side (newest/tail, not first-N) is
 * asserted by identity so a `slice(0, N)` "fix" cannot pass. Offline.
 */
import { DISPATCHES_MAX_ROWS, dispatchesProblem } from "../src/lean/state-dispatches.ts";
import { budgetVerdictWithRows, type DispatchUsageRow } from "../src/lean/step-budget.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.log(`FAIL test-AC1-budget-rows-cap.ts: ${msg}`);
    process.exit(1);
  }
}

/** A row whose identity is readable in a failure message. */
function row(n: number): DispatchUsageRow {
  return {
    role: `role-${String(n)}`,
    ms: n,
    ok: true,
    usage: { input: n, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  };
}

/** The roles of a verdict's rows, oldest first. */
function roles(oc: { dispatches?: DispatchUsageRow[] }): string[] {
  return (oc.dispatches ?? []).map((r) => r.role);
}

const OVER = DISPATCHES_MAX_ROWS + 4;
const all = Array.from({ length: OVER }, (_, i) => row(i));

// The rows a step may legally hand a verdict: the cap is the record's bound, so
// a caller that overflows it is the bug this file is about. Asserted against the
// validator's own message rather than a bare boolean, so a refusal here says
// which rule fired instead of looking like a made-up row shape.
assert(
  dispatchesProblem(all.slice(-DISPATCHES_MAX_ROWS)) === undefined,
  `the fixture rows are legal (problem: ${String(dispatchesProblem(all.slice(-DISPATCHES_MAX_ROWS)))})`,
);
assert(
  dispatchesProblem(all) !== undefined,
  `more rows than the cap is what the record validator refuses (cap ${String(DISPATCHES_MAX_ROWS)})`,
);

// ── (1) the verdict the step would persist carries at most the cap.
{
  const oc = budgetVerdictWithRows("build", { limit: "turns", value: 30, used: 31 }, all);
  const rows = oc.dispatches ?? [];
  assert(
    rows.length <= DISPATCHES_MAX_ROWS,
    `a budget verdict keeps at most ${String(DISPATCHES_MAX_ROWS)} rows, got ${String(rows.length)}`,
  );
  // The same validator the durable record runs, against what the step returned:
  // an over-long array is refused outright, so the step's cost never lands.
  assert(
    dispatchesProblem(rows) === undefined,
    `the verdict's rows pass the record validator (problem: ${String(dispatchesProblem(rows))})`,
  );
}

// ── (2) the survivors are the NEWEST — the tail, not the head.
{
  const oc = budgetVerdictWithRows(
    "challenge",
    { limit: "tokens", value: 1000, used: 2000 },
    all,
  );
  const expected = all.slice(-DISPATCHES_MAX_ROWS).map((r) => r.role);
  assert(
    JSON.stringify(roles(oc)) === JSON.stringify(expected),
    `the kept rows are the newest ${String(DISPATCHES_MAX_ROWS)} (got ${JSON.stringify(roles(oc))}, want ${JSON.stringify(expected)})`,
  );
}

// ── (3) a run inside the cap is untouched, rows and all.
{
  const few = all.slice(0, 3);
  const oc = budgetVerdictWithRows("specify", { limit: "minutes", value: 20, used: 21 }, few);
  assert(
    JSON.stringify(roles(oc)) === JSON.stringify(few.map((r) => r.role)),
    `rows within the cap are kept as they were (got ${JSON.stringify(roles(oc))})`,
  );
  assert(oc.kind === "budget", `the verdict is still a budget verdict (got ${oc.kind})`);
}

// ── (4) no rows is still no `dispatches` field.
{
  const oc = budgetVerdictWithRows("build", { limit: "turns", value: 5, used: 6 }, []);
  assert(
    oc.dispatches === undefined,
    `a step that paid for nothing records no rows (got ${JSON.stringify(oc.dispatches)})`,
  );
}

process.exit(0);
