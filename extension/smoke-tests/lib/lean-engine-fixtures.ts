#!/usr/bin/env bun
/**
 * lean/engine test fixtures — shared by `test-lean-engine.ts` (the end-to-end
 * half) and `test-lean-engine-crash.ts` (the resume half).
 *
 * Lives in `lib/` and is never executed on its own: the CI glob only runs
 * `test-*.ts`, and a fixture that ran its own cases would report someone
 * else's verdict. That is also why the pass/fail counter is a function here
 * rather than a module-level side effect — the two halves each exit on their
 * own copy of it.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LeanHandlers } from "../../src/lean/engine.ts";
import { next } from "../../src/lean/machine.ts";
import {
  INITIAL_COUNTERS,
  type LeanRun,
  type LeanState,
  type Outcome,
} from "../../src/lean/state.ts";
import { leanStateFile } from "../../src/lean/state.ts";

/** The one clock every case uses, so a timestamp in the log is a number we chose. */
export const CLOCK = 1_700_000_000_000;

export function ticking(): { now: () => number; elapsed: () => number } {
  const ms = CLOCK;
  return { now: () => ms, elapsed: () => ms - CLOCK };
}

export function makeAssert(): {
  assert: (cond: boolean, msg: string) => void;
  failures: () => number;
} {
  let failed = 0;
  return {
    assert: (cond, msg) => {
      if (cond) console.log(`\u2713 ${msg}`);
      else {
        console.error(`\u2717 ${msg}`);
        failed = 1;
      }
    },
    failures: () => failed,
  };
}

/**
 * A script-driven handler set. Each state returns the outcomes queued for it,
 * in order, and `calls` records every invocation so a resume can be judged on
 * what actually ran rather than on what the run claims.
 */
export function scripted(plan: Partial<Record<LeanState, Outcome[]>>): {
  handlers: LeanHandlers;
  calls: Record<string, number>;
} {
  const calls: Record<string, number> = {};
  const remaining: Partial<Record<LeanState, Outcome[]>> = {};
  for (const [k, v] of Object.entries(plan)) remaining[k as LeanState] = [...(v ?? [])];
  const handlers: LeanHandlers = {};
  const states: LeanState[] = [
    "ready",
    "specify",
    "build",
    "challenge",
    "verify",
    "publish",
    "review",
    "ci",
    "land",
    "handback",
    "decline",
  ];
  for (const state of states) {
    handlers[state] = async () => {
      calls[state] = (calls[state] ?? 0) + 1;
      const queue = remaining[state];
      if (!queue || queue.length === 0) throw new Error(`no scripted outcome for ${state}`);
      return queue.shift() as Outcome;
    };
  }
  return { handlers, calls };
}

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "lean-engine-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A state file with the states before `at` completed, so a case can start the
 * drive deep in the table without re-running the states before it.
 * Hand-written rather than driven: driving there would exercise the very
 * memoization the case is about.
 */
export function seedUpTo(dir: string, issue: number, at: LeanState): void {
  const order: LeanState[] = [
    "ready",
    "specify",
    "build",
    "challenge",
    "verify",
    "publish",
    "review",
    "ci",
    "land",
  ];
  const firstOutcome: Partial<Record<LeanState, Outcome>> = {
    ready: { kind: "ok" },
    specify: { kind: "ok" },
    build: { kind: "ok" },
    challenge: { kind: "none" },
    verify: { kind: "green" },
    publish: { kind: "ok" },
    review: { kind: "done" },
    ci: { kind: "green" },
    land: { kind: "merged" },
  };
  const steps = order.slice(0, order.indexOf(at)).map((s) => ({
    key: `${issue}:${s}:0`,
    state: s,
    startedAt: CLOCK,
    endedAt: CLOCK,
    outcome: firstOutcome[s] as Outcome,
  }));
  const seed0: LeanRun = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: "base",
    branch: `feature/issue-${issue}`,
    state: "ready",
    counters: { ...INITIAL_COUNTERS },
    steps,
  };
  const counters = { ...INITIAL_COUNTERS };
  // Counters are replayed through the REAL table rather than guessed at: the
  // fold in `runLean` derives the same numbers from the same log and refuses
  // the file when they disagree, so a fixture that invented its own counter
  // arithmetic would fail the very test that is about resuming.
  for (const s of steps) {
    const moved = next({ ...seed0, state: s.state, counters }, s.outcome as Outcome);
    counters.buildAttempts = moved.counters.buildAttempts;
    counters.challengeDone = moved.counters.challengeDone;
    counters.reviewDone = moved.counters.reviewDone;
    counters.ciFixUsed = moved.counters.ciFixUsed;
    counters.draft = moved.counters.draft;
  }
  const seed: LeanRun = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: "base",
    branch: `feature/issue-${issue}`,
    state: at,
    counters,
    steps,
  };
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  writeFileSync(leanStateFile(dir, issue), JSON.stringify(seed, null, 2), "utf8");
}

/** The outcomes that carry a run straight to `landed`. */
export const HAPPY: Partial<Record<LeanState, Outcome[]>> = {
  ready: [{ kind: "ok" }],
  specify: [{ kind: "ok" }],
  build: [{ kind: "ok" }, { kind: "ok" }],
  challenge: [{ kind: "none" }],
  verify: [{ kind: "green" }],
  publish: [{ kind: "ok" }],
  review: [{ kind: "done" }],
  ci: [{ kind: "green" }],
  land: [{ kind: "merged" }],
  handback: [{ kind: "done" }],
  decline: [{ kind: "done" }],
};
