#!/usr/bin/env bun
/**
 * lean/state-outcome — the `blockedBy` field of a build's `blocked` verdict (#1984).
 *
 * Split from `test-lean-state-outcome.ts` for the 500-line gate (AGENTS.md §12):
 * that file owns WHO may record an evidence field, and its BAD table is where a
 * reader looks for the ownership rules. This one owns the shape of the one field
 * the build step's early stop added, driven through `loadRun` — the entry point
 * the engine drives from — so a record this shape can never be driven, however
 * it came to be written.
 *
 * `blockedBy` is printed by `handback` as the run's CAUSE, so every rule here
 * protects a reader of a public comment: the key must be a path that could
 * really have been frozen (the frozen-key rule, not the criterion-id rule
 * `commandNotRunnable` uses — a `../` name never hashed to a record and a `\n`
 * writes a heading), and the value must be bounded prose the child wrote rather
 * than a blob it stuffed in.
 */

import { REPORTING_STATES } from "../src/lean/state-outcome.ts";
import {
  BLOCKED_MAX_ENTRIES,
  BLOCKED_MAX_REASON_CHARS,
} from "../src/lean/build-blocked.ts";
import { INITIAL_COUNTERS, REPORT_STATES, leanStateFile, loadRun } from "../src/lean/state.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { FIXTURE_BASE_SHA, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const CLOCK = 1000;

const STEP = (issue: number, state: string, n: number, kind: string) => ({
  key: `${issue}:${state}:${n}`,
  state,
  startedAt: CLOCK,
  endedAt: CLOCK,
  outcome: { kind },
});

function seeded(dir: string, issue: number, step: Record<string, unknown>): void {
  mkdirSync(leanStateFile(dir, issue).slice(0, leanStateFile(dir, issue).lastIndexOf("/")), {
    recursive: true,
  });
  writeFileSync(
    leanStateFile(dir, issue),
    JSON.stringify(
      {
        schema: 1,
        issue,
        version: "test",
        models: {},
        baseSha: FIXTURE_BASE_SHA,
        branch: `feature/issue-${issue}`,
        state: "handback",
        counters: INITIAL_COUNTERS,
        steps: [STEP(issue, "ready", 0, "ok"), step],
      },
      null,
      2,
    ),
    "utf8",
  );
}

for (const [label, issue, step, expect] of [
  [
    // The field is the build step's account of tests IT re-ran. On a step that
    // dispatched no builder it is a conflict nobody proved, and the ownership
    // rule must fire before any shape rule — a well-formed map is still a lie.
    "blockedBy on a verify step",
    70,
    {
      key: "70:verify:0",
      state: "verify",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "red", blockedBy: { "tests/a.test.ts": "mutually exclusive assertions" } },
    },
    /outcome blockedBy is only recorded by a build step/,
  ],
  [
    // A traversing name could never have been a frozen record, so accepting it
    // would let a hand-edited file name any file in the checkout as the run's
    // cause. Same rule `frozen` itself is held to.
    "blockedBy keyed by a traversing path",
    71,
    {
      key: "71:build:0",
      state: "build",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "blocked", blockedBy: { "../outside.test.ts": "x" } },
    },
    /outcome blockedBy key .* is not a valid test path/,
  ],
  [
    // Values are the child's prose, bounded by the same 300 as every other
    // reason that reaches a comment.
    "blockedBy with an unbounded reason",
    72,
    {
      key: "72:build:0",
      state: "build",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "blocked", blockedBy: { "tests/a.test.ts": "y".repeat(301) } },
    },
    /outcome blockedBy\["tests\/a\.test\.ts"\] must be at most 300 characters/,
  ],
  [
    // A non-string value would be printed as `[object Object]` into the cause
    // line, which reads as a sentence and means nothing.
    "blockedBy whose value is not prose",
    73,
    {
      key: "73:build:0",
      state: "build",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "blocked", blockedBy: { "tests/a.test.ts": 7 } },
    },
    /outcome blockedBy\["tests\/a\.test\.ts"\] must be a string/,
  ],
  [
    // More entries than the driver ever vets were not written by it: the report
    // tool caps at 32 and the gate refuses the rest, so a wider map is a blob.
    "blockedBy with more entries than the step can vet",
    74,
    {
      key: "74:build:0",
      state: "build",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: {
        kind: "blocked",
        blockedBy: Object.fromEntries(
          Array.from({ length: 33 }, (_, i) => [`tests/f${String(i)}.test.ts`, "x"]),
        ),
      },
    },
    /outcome blockedBy must hold at most 32 files/,
  ],
  [
    "blockedBy that is not a map",
    75,
    {
      key: "75:build:0",
      state: "build",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: { kind: "blocked", blockedBy: "tests/a.test.ts" },
    },
    /outcome blockedBy must be an object/,
  ],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    seeded(dir, issue, step);
    let thrown: unknown;
    try {
      loadRun(dir, issue);
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && thrown.name === "LeanStateError",
      `a forged ${label} is refused at load (got: ${String(thrown)})`,
    );
    assert(
      expect.test((thrown as Error)?.message ?? ""),
      `the refusal for a forged ${label} names the field (got: ${(thrown as Error)?.message})`,
    );
    assert(
      (thrown as Error)?.message.includes(String(step.key)) === true,
      `the refusal names the step key (got: ${(thrown as Error)?.message})`,
    );
  } finally {
    cleanup();
  }
}

// The one shape that IS legitimate: a build step's `blocked` verdict carrying
// the map the driver vetted. Refusing it would refuse the only record the run
// can write for the cause, and `handback` prints it from exactly this field.
{
  const { dir, cleanup } = tempDir();
  try {
    seeded(dir, 76, {
      key: "76:build:0",
      state: "build",
      startedAt: CLOCK,
      endedAt: CLOCK,
      outcome: {
        kind: "blocked",
        reason: "frozen tests cannot all pass together: tests/a.test.ts — case 2 vs case 3",
        blockedBy: { "tests/a.test.ts": "case 2 needs the array mutable, case 3 mutates it" },
        dispatches: [
          { role: "developer", ms: 5, ok: true, usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 3 } },
        ],
      },
    });
    let thrown: unknown;
    let loaded: unknown;
    try {
      loaded = loadRun(dir, 76);
    } catch (err) {
      thrown = err;
    }
    assert(thrown === undefined, `a build step's blockedBy loads (got: ${String(thrown)})`);
    const steps = (loaded as { steps?: { outcome?: { blockedBy?: Record<string, string> } }[] })
      ?.steps;
    assert(
      steps?.[1]?.outcome?.blockedBy?.["tests/a.test.ts"] ===
        "case 2 needs the array mutable, case 3 mutates it",
      `the rebuilt record keeps the reason verbatim (got ${JSON.stringify(steps?.[1]?.outcome?.blockedBy)})`,
    );
  } finally {
    cleanup();
  }
}

assert(
  JSON.stringify(REPORTING_STATES) === JSON.stringify(REPORT_STATES),
  "the ownership table's REPORTING_STATES still equals state.ts's REPORT_STATES",
);

// The gate that VETS a report and the loader that PERSISTS it must hold the same
// two bounds. They now read one pair of constants (`state-outcome-maps.ts`), so
// this asserts the number the record enforces rather than a copy: widening the
// record alone would leave the gate refusing entries the loader accepts, and a
// gate wider than the record spends a runner on an entry that cannot be saved.
assert(
  BLOCKED_MAX_ENTRIES === 32 && BLOCKED_MAX_REASON_CHARS === 300,
  `the gate's bounds still equal the record's 32 / 300 (got ${String(BLOCKED_MAX_ENTRIES)} / ${String(BLOCKED_MAX_REASON_CHARS)})`,
);

process.exit(failures());
