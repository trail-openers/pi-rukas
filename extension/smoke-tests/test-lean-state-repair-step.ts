#!/usr/bin/env bun
/**
 * lean/state — a decided `repair` step survives save-then-load.
 *
 * The round writes `repair`, `frozen` and its own `dispatches` rows, so those
 * fields have to be owned by the `repair` state or `assertRun` refuses the
 * record as forged. The rows are the quiet half of the bug: `repair` dispatches
 * a child, and a step outside `DISPATCH_STATES` has its cost rows DROPPED
 * rather than refused, so the file loads and the cost is simply gone.
 *
 * The run goes through the real `saveRun` and comes back through the real
 * `loadRun`, so this is the round trip the engine performs and not a fixture of
 * a validator.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { errorOutcome } from "../src/lean/error-outcome.ts";
import { DISPATCH_STATES } from "../src/lean/state-outcome.ts";
import { INITIAL_COUNTERS, type LeanRun, type LeanState, leanStateFile } from "../src/lean/state.ts";
import { loadRun, saveRun } from "../src/lean/state-store.ts";
import { FIXTURE_BASE_SHA, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const CLOCK = 1000;
const FROZEN_PATH = "tests/AC1-retry.test.sh";
const FROZEN_HASH = "a".repeat(64);
const ORIGINAL_HASH = "c".repeat(64);
const HEAD = "b".repeat(40);

const USAGE = { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, turns: 4, cost: 0.5 };
const ROW = { role: "developer", ms: 1_000, ok: true, usage: USAGE };

/** The record the round's own step body writes for an accepted replacement. */
function roundOutcome(): Record<string, unknown> {
  return {
    kind: "repaired",
    reason: "the driver accepted a corrected tests/AC1-retry.test.sh",
    frozen: { [FROZEN_PATH]: FROZEN_HASH },
    repair: {
      round: 1,
      baseSha: HEAD,
      originalHashes: { [FROZEN_PATH]: ORIGINAL_HASH },
      passedAtHead: { [FROZEN_PATH]: true },
    },
    dispatches: [ROW],
  };
}

/** The log a run that repaired once really holds: blocked build, then the round. */
function logFor(issue: number): LeanRun["steps"] {
  const step = (state: LeanState, outcome: Record<string, unknown>) => ({
    key: `${issue}:${state}:0`,
    state,
    startedAt: CLOCK,
    endedAt: CLOCK,
    outcome,
  });
  return [
    step("ready", { kind: "ok" }),
    step("specify", { kind: "ok", frozen: { [FROZEN_PATH]: ORIGINAL_HASH } }),
    step("build", {
      kind: "blocked",
      blockedBy: { [FROZEN_PATH]: "the frozen assertion cannot hold" },
      headBefore: HEAD,
    }),
    step("repair", roundOutcome()),
  ] as LeanRun["steps"];
}

function runAt(issue: number): LeanRun {
  return {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: FIXTURE_BASE_SHA,
    branch: `feature/issue-${String(issue)}`,
    // Where the table puts a run once the round accepted: back through `build`.
    state: "build",
    counters: { ...INITIAL_COUNTERS, buildAttempts: 1, repairsSpent: 1 },
    steps: logFor(issue),
    oracleRepair: true,
  };
}

// ── a decided repair step round-trips through save and load
{
  const { dir, cleanup } = tempDir();
  try {
    const issue = 2668;
    saveRun(dir, runAt(issue));
    let loaded: LeanRun | undefined;
    try {
      loaded = loadRun(dir, issue);
      assert(true, "a decided repair step loads without throwing");
    } catch (err) {
      assert(false, `a decided repair step loads without throwing (got ${(err as Error).message})`);
      cleanup();
      process.exit(failures());
    }
    const step = loaded?.steps.find((s) => s.state === "repair");
    assert(step !== undefined, "the repair step is on the loaded log");
    assert(
      step?.outcome?.kind === "repaired",
      `the round's verdict survived (got ${String(step?.outcome?.kind)})`,
    );
    assert(
      step?.outcome?.repair?.passedAtHead?.[FROZEN_PATH] === true,
      "the repair record survived with its at-head observation",
    );
    assert(
      step?.outcome?.frozen?.[FROZEN_PATH] === FROZEN_HASH,
      "the corrected frozen hash survived",
    );
    // The rows are the field this file exists for.
    assert(
      step?.outcome?.dispatches?.length === 1,
      `the round's dispatch row survived the round trip (got ${String(
        step?.outcome?.dispatches?.length,
      )})`,
    );
  } finally {
    cleanup();
  }
}

// ── the same record written as bytes, so the loader's table is what is judged
{
  const { dir, cleanup } = tempDir();
  try {
    const issue = 2669;
    mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
    writeFileSync(
      leanStateFile(dir, issue),
      `${JSON.stringify(runAt(issue), null, 2)}\n`,
      "utf8",
    );
    try {
      const loaded = loadRun(dir, issue);
      assert(
        loaded?.steps.some((s) => s.state === "repair") === true,
        "the hand-written repair record loads with its repair step",
      );
    } catch (err) {
      assert(false, `the hand-written repair record loads (got ${(err as Error).message})`);
    }
  } finally {
    cleanup();
  }
}

// ── errorOutcome keeps a repair step's rows, the way it keeps build's
{
  const err = Object.assign(new Error("the round threw"), { dispatches: [ROW] });
  const repair = errorOutcome("repair", err);
  const build = errorOutcome("build", err);
  assert(
    JSON.stringify(repair.dispatches) === JSON.stringify(build.dispatches) &&
      repair.dispatches?.length === 1,
    `a thrown repair step keeps its cost rows exactly as a thrown build step does (got ${String(
      repair.dispatches?.length,
    )} vs ${String(build.dispatches?.length)})`,
  );
  assert(
    DISPATCH_STATES.includes("repair"),
    "`repair` is one of the states that may record cost",
  );
}

process.exit(failures());
