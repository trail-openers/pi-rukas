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
  type RunCounters,
} from "../../src/lean/state.ts";
import { leanStateFile } from "../../src/lean/state.ts";

/** The one clock every case uses, so a timestamp in the log is a number we chose. */
export const CLOCK = 1_700_000_000_000;

/**
 * A full lowercase oid every base case uses as "a real base".
 *
 * `lean/state.ts` refuses a record whose `baseSha` is neither `""` nor a full
 * commit sha, so a fixture that wrote the literal `"base"` would be refused at
 * load and every case that resumes one would be testing the refusal instead of
 * what it means to test. Exported so a case can compare against the same value
 * the fixture wrote rather than repeating the literal.
 */
export const FIXTURE_BASE_SHA = "0123456789abcdef0123456789abcdef01234567";

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
export function seedUpTo(
  dir: string,
  issue: number,
  at: LeanState,
  base: Partial<Pick<LeanRun, "baseSha" | "branch">> = {},
): void {
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
    baseSha: base.baseSha ?? FIXTURE_BASE_SHA,
    branch: base.branch ?? `feature/issue-${issue}`,
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
    baseSha: base.baseSha ?? FIXTURE_BASE_SHA,
    branch: base.branch ?? `feature/issue-${issue}`,
    state: at,
    counters,
    steps,
  };
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  writeFileSync(leanStateFile(dir, issue), JSON.stringify(seed, null, 2), "utf8");
}

/**
 * Write a seed file whose log is the walk `walk` describes, with the snapshot
 * DERIVED the way a real drive derives it.
 *
 * A hand-written state file has to agree with the fold in `resume.ts` or the
 * run refuses to load at all, and reasoning out the owed-build-round rule to
 * write a fixture that is not ABOUT the fold is a tax every case pays. So the
 * fixture states the walk (each entry: state, attempt, outcome kind, and a
 * fourth element meaning "written ahead, never decided — the bytes a kill
 * leaves behind") and this derives the position with the same table a drive
 * uses. The result is a file no different from one the engine wrote, which is
 * what makes the cases that read it worth anything.
 */
export function seedWalk(
  dir: string,
  issue: number,
  walk: [LeanState, number, string?, boolean?][],
  base: Partial<Pick<LeanRun, "baseSha" | "branch">> = {},
): LeanRun {
  return writeSeed(dir, issue, walkToSteps(walk), deriveSeedPosition(walk), base);
}
/** The array form of a `seedWalk` walk, shared with `writeVerifiedSeed`. */
function walkToSteps(walk: [LeanState, number, string?, boolean?][]): LeanRun["steps"] {
  return walk.map(([state, n, kind, pending]) => ({
    key: `0:${state}:${n}`,
    state,
    startedAt: CLOCK,
    ...(kind === undefined || pending ? {} : { endedAt: CLOCK, outcome: { kind } as Outcome }),
  }));
}

/**
 * Write a seed from an ALREADY-BUILT step log, with a snapshot the fold accepts.
 *
 * For a fixture whose log comes from a named fixture module rather than from an
 * inline walk — the same derivation, so no case has to reason about owed build
 * rounds to write a file the loader will read.
 */
export function writeVerifiedSeed(
  dir: string,
  issue: number,
  steps: { key: string; state: LeanState; outcome?: { kind?: string } }[],
  base: Partial<Pick<LeanRun, "baseSha" | "branch"> & { counters?: Partial<RunCounters> }> = {},
): LeanRun {
  const walk: [LeanState, number, string?, boolean?][] = steps.map((s) => [
    s.state,
    Number(s.key.slice(s.key.lastIndexOf(":") + 1)),
    s.outcome?.kind,
  ]);
  const position = deriveSeedPosition(walk);
  return writeSeed(dir, issue, walkToSteps(walk), {
    ...position,
    counters: { ...position.counters, ...(base.counters ?? {}) },
  });
}

function writeSeed(
  dir: string,
  issue: number,
  steps: LeanRun["steps"],
  position: { state: LeanState; counters: LeanRun["counters"] },
  base: Partial<Pick<LeanRun, "baseSha" | "branch">> = {},
): LeanRun {
  const seed: LeanRun = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: base.baseSha ?? FIXTURE_BASE_SHA,
    branch: base.branch ?? `feature/issue-${issue}`,
    state: position.state,
    counters: position.counters,
    // The keys the walk form carries a placeholder issue for are rewritten to
    // the real one, which is the shape `saveRun` writes.
    steps: steps.map((s) => ({ ...s, key: s.key.replace(/^0:/, `${issue}:`) })),
  };
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  writeFileSync(leanStateFile(dir, issue), JSON.stringify(seed, null, 2), "utf8");
  return seed;
}

/**
 * Walk the log through `next()` the way the fold does, and return the position
 * a drive would have saved when it wrote the last entry.
 *
 * The rules are copied from how the engine actually behaves rather than
 * invented: a build round is spent on ENTERING build (a `viaBuild` edge is the
 * only way in — see transitions.ts), so every entry the log records for a
 * build round already carries its billing in the arrow that routed there; and
 * a pending entry is the write-ahead, which the engine saves at the moment it
 * writes, so the snapshot sits on the state that entry belongs to.
 */
function deriveSeedPosition(walk: [LeanState, number, string?, boolean?][]): {
  state: LeanState;
  counters: LeanRun["counters"];
} {
  const seed0: LeanRun = {
    schema: 1,
    issue: 0,
    version: "test",
    models: {},
    baseSha: "",
    branch: "",
    state: "ready",
    counters: { ...INITIAL_COUNTERS },
    steps: [],
  };
  let counters: LeanRun["counters"] = { ...INITIAL_COUNTERS };
  let state: LeanState = walk[0]?.[0] ?? "ready";
  for (const [stepState, , kind, pending] of walk) {
    state = stepState;
    if (kind === undefined || pending) continue;
    counters = next({ ...seed0, state, counters }, { kind } as Outcome).counters;
  }
  return { state, counters };
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
