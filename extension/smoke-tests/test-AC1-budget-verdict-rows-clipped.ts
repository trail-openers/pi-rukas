#!/usr/bin/env bun
/**
 * #1967 AC1 — `budgetVerdictWithRows` must clip its rows to the validator's own
 * cap, keeping the NEWEST (the tail).
 *
 * The done path does this (`cleanPass` in `lean/review-pass.ts` hands the engine
 * `rows.slice(-DISPATCHES_MAX_ROWS)`, and `specify` and the throw path clip the
 * same way). The budget path did not: it spread the caller's array straight onto
 * the verdict. `dispatchesProblem` refuses any `dispatches` array longer than
 * `DISPATCHES_MAX_ROWS`, and a step's outcome is validated when the run's state
 * file is READ BACK (`assertRunFile` → `outcomeProblem`) — so a budget stop whose
 * step had paid for more children than the cap does not report a long run, it
 * makes the run's own state file unloadable: a resume of that run dies in
 * `loadRun`. The cheapest arm to breach is exactly the arm with no clip.
 *
 * Driven through the real entry point, and judged on the two facts the criterion
 * states: the verdict's own rows are within the cap and hold the newest children,
 * and the record the loader must accept is the record this function built.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DISPATCHES_MAX_ROWS } from "../src/lean/state-outcome.ts";
import { loadRun } from "../src/lean/state-store.ts";
import { budgetVerdictWithRows } from "../src/lean/step-budget.ts";
import type { BudgetFired, DispatchUsageRow } from "../src/lean/step-budget.ts";
import { FIXTURE_BASE_SHA, makeAssert } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const FILE = "test-AC1-budget-verdict-rows-clipped.ts";

/** One child the step paid for, identifiable by `role`. */
function row(n: number): DispatchUsageRow {
  return {
    role: `child-${String(n)}`,
    ms: 100 * (n + 1),
    ok: true,
    usage: { input: n, output: n, cacheRead: 0, cacheWrite: 0, cost: 0, turns: n },
  };
}

const FIRED: BudgetFired = { limit: "turns", value: 40, used: 41 };
/** More children than one step may record — a six-lens round plus its fixers. */
const OVER = DISPATCHES_MAX_ROWS + 4;
const rows = Array.from({ length: OVER }, (_, i) => row(i));
const newest = Array.from(
  { length: DISPATCHES_MAX_ROWS },
  (_, i) => `child-${String(i + OVER - DISPATCHES_MAX_ROWS)}`,
);

const verdict = budgetVerdictWithRows("build", FIRED, rows);
const got: DispatchUsageRow[] = (verdict as { dispatches?: DispatchUsageRow[] }).dispatches ?? [];

assert(
  got.length <= DISPATCHES_MAX_ROWS,
  `${FILE}: a budget verdict holds at most ${String(DISPATCHES_MAX_ROWS)} rows, like the done path — the step paid for ${String(OVER)} children and the verdict carries ${String(got.length)}`,
);
assert(
  got.length === DISPATCHES_MAX_ROWS && got.every((r, i) => r.role === newest[i]),
  `${FILE}: the rows it keeps are the NEWEST (the tail of what the step paid for), got ${JSON.stringify(got.map((r) => r.role))}`,
);

// The same record through the loader: the cap is not a cosmetic bound, it is what
// keeps the run's state file readable, and an over-long `dispatches` array is
// refused there rather than reported.
{
  const dir = mkdtempSync(path.join(tmpdir(), "lean-ac1-"));
  try {
    mkdirSync(path.join(dir, ".pi", "lean-state"), { recursive: true });
    const run = {
      schema: 1,
      issue: 7,
      version: "test",
      models: {},
      baseSha: FIXTURE_BASE_SHA,
      branch: "feature/issue-7",
      state: "build",
      counters: {
        buildAttempts: 0,
        challengeDone: false,
        reviewDone: false,
        ciFixUsed: false,
        draft: false,
      },
      steps: [{ key: "7:build:0", state: "build", startedAt: 1, endedAt: 2, outcome: verdict }],
    };
    writeFileSync(path.join(dir, ".pi", "lean-state", "7.json"), JSON.stringify(run), "utf8");
    let loaded: unknown;
    let threw: string | undefined;
    try {
      loaded = loadRun(dir, 7);
    } catch (err) {
      threw = (err as Error).message;
    }
    assert(
      threw === undefined && loaded !== undefined,
      `${FILE}: the verdict this function builds survives a round trip through the state file the run is resumed from${threw === undefined ? "" : ` — loader refused it: ${threw}`}`,
    );
    const oc = (loaded as { steps?: { outcome?: { dispatches?: DispatchUsageRow[] } }[] })
      ?.steps?.[0]?.outcome;
    assert(
      (oc?.dispatches?.length ?? 0) === DISPATCHES_MAX_ROWS,
      `${FILE}: the resumed record still prices every child the cap allows, got ${String(oc?.dispatches?.length)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The empty case stays what it was: no rows, no `dispatches` field.
{
  const empty = budgetVerdictWithRows("challenge", FIRED, []);
  assert(
    (empty as { dispatches?: unknown }).dispatches === undefined,
    `${FILE}: a budget stop that paid for nobody still records no dispatches field`,
  );
}

process.exit(failures());
