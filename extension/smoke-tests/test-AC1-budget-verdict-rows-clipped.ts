#!/usr/bin/env bun
/**
 * #1967 AC1 — `budgetVerdictWithRows` must clip its rows like every other
 * `dispatches` surface does.
 *
 * `budgetVerdictWithRows` is the one writer of `outcome.dispatches` that never
 * applied the validator's own bound. The `done` path in `review.ts` clips through
 * `cleanPass` (`rows.slice(-DISPATCHES_MAX_ROWS)`), as do `ReviewInfraError`,
 * `errorOutcome` and `specify`'s merge — and the rule those four honour is the one
 * the loader enforces (`dispatchesProblem` refuses an over-long array). The budget
 * verdict spreads its rows in verbatim, so a step whose `rows` accumulate across
 * the whole attempt (build/challenge/specify each bill every child they paid for)
 * could hand the engine a record past the cap — and `assertRunFile` does not drop
 * an over-long field on the budget path, it REFUSES the whole state file, so a
 * stopped step with no route back costs the run its resume and every child it
 * paid for. The tail is what the operator needs, because the child that ran last
 * is the one the ceiling stopped.
 *
 * So the cases drive the REAL entry points: the function's own return, and the
 * durable round trip (`saveRun`/`loadRun`) a run of this shape actually takes.
 */

import { DISPATCHES_MAX_ROWS, buildOutcome } from "../src/lean/state-outcome.ts";
import { type LeanRun, loadRun, saveRun } from "../src/lean/state.ts";
import { type DispatchUsageRow, budgetVerdictWithRows } from "../src/lean/step-budget.ts";
import { FIXTURE_BASE_SHA, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/** One child's cost row; `n` makes each row distinguishable in an assertion. */
function row(n: number, role = "developer"): DispatchUsageRow {
  return {
    role,
    ms: 100 * (n + 1),
    ok: true,
    usage: { input: n, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 3 },
  };
}

/** `n` rows in dispatch order, newest last. */
function rows(n: number, role = "developer"): DispatchUsageRow[] {
  return Array.from({ length: n }, (_, i) => row(i, role));
}

const FIRED = { limit: "turns" as const, value: 40, used: 46 };

// ── (1) the entry point: more rows than the cap, and the tail survives ──────
{
  const over = DISPATCHES_MAX_ROWS + 8;
  const verdict = budgetVerdictWithRows("build", FIRED, rows(over));
  const got = verdict.dispatches ?? [];
  assert(
    got.length <= DISPATCHES_MAX_ROWS,
    `FAIL test-AC1-budget-verdict-rows-clipped.ts (1): a budget verdict holds at most ${String(DISPATCHES_MAX_ROWS)} dispatch rows, the validator's own bound (got ${String(got.length)})`,
  );
  assert(
    got.length === DISPATCHES_MAX_ROWS &&
      got[0]?.ms === row(over - DISPATCHES_MAX_ROWS).ms &&
      got[got.length - 1]?.ms === row(over - 1).ms,
    `FAIL test-AC1-budget-verdict-rows-clipped.ts (1): it keeps the NEWEST rows — the child the ceiling stopped is the one the operator must be billed (first ms ${String(got[0]?.ms)}, last ms ${String(got[got.length - 1]?.ms)})`,
  );
  assert(
    verdict.kind === "budget" && /turns budget 40 exceeded \(used 46\)/.test(verdict.reason ?? ""),
    `FAIL test-AC1-budget-verdict-rows-clipped.ts (1): it is still the same budget verdict the sentence renders (${verdict.reason})`,
  );
}

// ── (2) the durable round trip: a stopped step's rows survive a load ────────
//
// The observable that matters: `dispatchesProblem` refuses an over-long array, and
// `assertRunFile` fails the whole file on it — so a run whose budget step billed
// more children than the cap could not be resumed at all. The case writes the
// verdict the entry point built into a real state file and reads it the way a
// resumed run does, and reports the refusal as a failed assertion rather than an
// uncaught throw (the loader's message is printed beside the assertion, so the
// cause is not lost).
{
  const { dir, cleanup } = tempDir();
  const over = DISPATCHES_MAX_ROWS + 8;
  const run: LeanRun = {
    schema: 1,
    issue: 7,
    version: "test",
    models: {},
    baseSha: FIXTURE_BASE_SHA,
    branch: "feature/issue-7",
    state: "handback",
    counters: {
      buildAttempts: 1,
      challengeDone: false,
      reviewDone: false,
      ciFixUsed: false,
      draft: false,
    },
    steps: [
      {
        key: "7:build:0",
        state: "build",
        startedAt: 1,
        endedAt: 2,
        // Built through the validator's own rebuilder, the way `assertRunFile`
        // rebuilds every persisted outcome, so the file on disk is what a step
        // that reported this verdict would have written.
        outcome: buildOutcome(
          budgetVerdictWithRows(
            "build",
            FIRED,
            rows(over, "code-review-specialist"),
          ) as unknown as Record<string, unknown>,
        ),
      },
    ],
  };
  saveRun(dir, run);
  let loaded: LeanRun | undefined;
  let loadErr = "";
  try {
    loaded = loadRun(dir, 7);
  } catch (err) {
    loadErr = (err as Error).message;
  }
  const recorded = loaded?.steps[0]?.outcome?.dispatches ?? [];
  assert(
    loadErr === "",
    `FAIL test-AC1-budget-verdict-rows-clipped.ts (2): a run whose budget step billed more children than the cap must still load — the loader refuses the whole file, so a stopped step with no route back costs the run its resume (${loadErr})`,
  );
  assert(
    recorded.length === DISPATCHES_MAX_ROWS,
    `FAIL test-AC1-budget-verdict-rows-clipped.ts (2): the resumed record holds the bounded rows the validator accepts (got ${String(recorded.length)})`,
  );
  assert(
    recorded.length > 0 &&
      recorded[0]?.ms === row(over - DISPATCHES_MAX_ROWS, "code-review-specialist").ms,
    `FAIL test-AC1-budget-verdict-rows-clipped.ts (2): the rows it reads back are the newest ones (first ms ${String(recorded[0]?.ms)})`,
  );
  cleanup();
}

process.exit(failures());
