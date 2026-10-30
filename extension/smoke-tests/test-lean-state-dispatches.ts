#!/usr/bin/env bun
/**
 * lean/state-outcome — the `dispatches` field of one step's outcome (#1920 A).
 *
 * The three dispatching steps (`specify`, `build`, `challenge`) record one cost
 * row per child they paid for, and a later result folds those rows into the
 * per-role usage a host reads. So a row that is merely PRESENT but the wrong
 * shape is not detail — it is a cost figure that reads as evidence and sums to
 * nothing, or, worse, subtracts: a negative `cost` lowers a total, a missing
 * `usage` reads as a free child, and a row with no `role` cannot be attributed
 * to one at all. `assertRun` refuses each at load, with the step's own key in
 * the message, and the cases go through `loadRun` — the entry point the engine
 * drives from — so a file this shape can never be driven.
 *
 * Split from `test-lean-state-outcome.ts` (the 500-line cap) along the field:
 * that file keeps the ownership rule for the fields `publish` and `verify`
 * produce; this one owns the array a dispatching step produces.
 *
 * The budget-trio cross-check belongs here because `dispatches` is what made it
 * load-bearing: the trio (`limit`/`value`/`used`) belongs to a `budget` verdict
 * ALONE — `handback` prints those three as the run's cause — and without the
 * rule, an `ok` step could claim a ceiling it never crossed by also reporting
 * what its children cost.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INITIAL_COUNTERS, type LeanState, leanStateFile, loadRun } from "../src/lean/state.ts";
import { FIXTURE_BASE_SHA, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const CLOCK = 1000;

/** A usage report and a dispatch row, in the shape the dispatching steps write. */
const USAGE = { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, turns: 4, cost: 0.5 };
const ROW = { role: "developer", ms: 1_000, ok: true, usage: USAGE };

/** The same row with a distinct `role`, so a byRole fold cannot merge the two. */
const OTHER = { ...ROW, role: "adversary" };

/**
 * A run whose ONLY fault is the `dispatches` field under test. Everything else
 * is the shape a real run writes — the same base, counters and states — so a
 * refusal that came from anything else would be a false alarm.
 */
function seedWithOutcome(
  dir: string,
  issue: number,
  state: LeanState,
  outcome: Record<string, unknown>,
): void {
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  const seed = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: FIXTURE_BASE_SHA,
    branch: `feature/issue-${issue}`,
    state: "handback",
    counters: INITIAL_COUNTERS,
    steps: [{ key: `${issue}:${state}:0`, state, startedAt: CLOCK, endedAt: CLOCK, outcome }],
  };
  writeFileSync(leanStateFile(dir, issue), JSON.stringify(seed, null, 2), "utf8");
}

/** A `build` step — one of the three states legitimately allowed to carry rows. */
const build = (issue: number, outcome: Record<string, unknown>) => ({
  state: "build" as const,
  key: `${issue}:build:0`,
  outcome,
});

/** The bad shapes, each in the one field position the case is about. */
const BAD: readonly [string, number, ReturnType<typeof build>, RegExp][] = [
  [
    "a dispatches field that is not an array",
    70,
    build(70, { kind: "ok", dispatches: "not an array" }),
    /dispatches must be an array/,
  ],
  [
    "a row that is not an object",
    71,
    build(71, { kind: "ok", dispatches: [null] }),
    /dispatches\[0\] must be an object/,
  ],
  [
    "a row with no usage report",
    72,
    build(72, { kind: "ok", dispatches: [{ role: "developer", ms: 1, ok: true }] }),
    /usage must carry non-negative integer/,
  ],
  [
    "a row whose cost is negative",
    73,
    build(73, {
      kind: "ok",
      dispatches: [{ role: "developer", ms: 1, ok: true, usage: { ...USAGE, cost: -1 } }],
    }),
    /usage must carry non-negative integer/,
  ],
  [
    "a row whose turns count is fractional",
    74,
    build(74, {
      kind: "ok",
      dispatches: [{ role: "developer", ms: 1, ok: true, usage: { ...USAGE, turns: 1.5 } }],
    }),
    /usage must carry non-negative integer/,
  ],
  [
    "a row whose input is infinite (1e400 arrives as Infinity from JSON)",
    75,
    build(75, {
      kind: "ok",
      dispatches: [{ role: "developer", ms: 1, ok: true, usage: { ...USAGE, input: 1e400 } }],
    }),
    /usage must carry non-negative integer/,
  ],
  [
    "a row whose ok is a string",
    76,
    build(76, { kind: "ok", dispatches: [{ role: "developer", ms: 1, ok: "yes", usage: USAGE }] }),
    /\.ok must be a boolean/,
  ],
  [
    "a row with no role, which no byRole row can hold it",
    77,
    build(77, { kind: "ok", dispatches: [{ role: "", ms: 1, ok: true, usage: USAGE }] }),
    /\.role must be a non-empty string/,
  ],
  [
    "a row whose ms is not finite",
    78,
    build(78, { kind: "ok", dispatches: [{ role: "developer", ms: 1e400, ok: true, usage: USAGE }] }),
    /\.ms must be a finite number/,
  ],
  [
    "an ok step claiming a budget ceiling beside its rows",
    79,
    build(79, { kind: "ok", limit: "turns", value: 1, used: 2, dispatches: [ROW] }),
    /only recorded by a budget verdict/,
  ],
  [
    "more rows than any one step can dispatch",
    80,
    build(80, {
      kind: "ok",
      dispatches: Array.from({ length: 17 }, (_, i) => ({ ...ROW, role: `r${String(i)}` })),
    }),
    /must hold at most 16 rows/,
  ],
];

for (const [label, issue, step, expect] of BAD) {
  const { dir, cleanup } = tempDir();
  try {
    seedWithOutcome(dir, issue, step.state, step.outcome);
    let thrown: unknown;
    try {
      loadRun(dir, issue);
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && thrown.name === "LeanStateError",
      `a bad record (${label}) is refused at load (got: ${String(thrown)})`,
    );
    assert(
      expect.test((thrown as Error)?.message ?? ""),
      `the refusal for ${label} says what is wrong (got: ${(thrown as Error)?.message})`,
    );
    assert(
      (thrown as Error)?.message.includes(step.key) === true,
      `the refusal names the step key (got: ${(thrown as Error)?.message})`,
    );
  } finally {
    cleanup();
  }
}

// A well-formed record loads and keeps its rows — and an EMPTY row list records
// no key at all, because `[]` would tell the fold "this step paid for zero
// children" where the truth is "this step is not one that dispatches".
for (const [label, issue, outcome, expected] of [
  ["one row", 86, { kind: "ok", dispatches: [ROW] }, 1],
  [
    "two rows on a budget verdict",
    87,
    {
      kind: "budget",
      limit: "turns",
      value: 3,
      used: 4,
      dispatches: [ROW, OTHER],
    },
    2,
  ],
  ["an empty row list", 88, { kind: "ok", dispatches: [] }, undefined],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    seedWithOutcome(dir, issue, "build", outcome);
    let thrown: unknown;
    let loaded: ReturnType<typeof loadRun>;
    try {
      loaded = loadRun(dir, issue);
    } catch (err) {
      thrown = err;
    }
    assert(thrown === undefined, `a valid record with ${label} loads (got: ${String(thrown)})`);
    const rows = loaded?.steps?.[0]?.outcome?.dispatches;
    assert(
      rows?.length === expected || (expected === undefined && rows === undefined),
      `${label}: got ${JSON.stringify(rows)}, expected ${String(expected)}`,
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());
