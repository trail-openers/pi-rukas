#!/usr/bin/env bun
/**
 * lean/engine — the crash/resume half. Split from `test-lean-engine.ts` for
 * the 500-line gate (AGENTS.md §12); the shared fixtures live in
 * `lib/lean-engine-fixtures.ts`.
 *
 * This is the half that earns the step log. "A step that has an outcome is
 * never re-run" cannot be shown by driving a run in one process — nothing
 * crashed, so nothing had to be recovered. Both cases here start from a state
 * file the process did not just write, and both are judged on CALL COUNTS:
 *
 *   - a handler that throws after its step was written ahead: the run ends
 *     handed-back rather than looping, and re-driving a finished run runs
 *     nothing at all;
 *   - a step left on disk WITHOUT an outcome (the exact bytes a kill leaves
 *     between the write-ahead and the outcome): the resume re-runs that one
 *     step, reuses its key, keeps its `startedAt`, and never touches a
 *     completed one.
 *
 * The second case hand-writes its state file deliberately. Going through the
 * engine to produce "a step with no outcome" would record the outcome the
 * crash was supposed to prevent.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runLean, type LeanHandlers } from "../src/lean/engine.ts";
import type { LeanRun, LeanState, Outcome } from "../src/lean/state.ts";
import { leanStateFile, loadRun } from "../src/lean/state.ts";
import { CLOCK, HAPPY, makeAssert, scripted, tempDir, ticking } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

// ── the crash case: a re-run only re-runs the step that never finished ─────

{
  const { dir, cleanup } = tempDir();
  try {
    let buildCrashes = true;
    const calls: Record<string, number> = {};
    const plan: Partial<Record<LeanState, Outcome[]>> = { ...HAPPY };
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
    ];
    for (const state of states) {
      handlers[state] = async () => {
        calls[state] = (calls[state] ?? 0) + 1;
        if (state === "build" && buildCrashes) {
          // The crash lands AFTER the write-ahead, which is the only moment
          // that produces a step with no outcome — the case a resume must
          // recover from by re-running exactly that step.
          buildCrashes = false;
          throw new Error("simulated crash mid-build");
        }
        const queue = plan[state];
        if (!queue || queue.length === 0) throw new Error(`no scripted outcome for ${state}`);
        return queue.shift() as Outcome;
      };
    }
    const clock = ticking();
    const first = await runLean({ repoRoot: dir, issue: 9, handlers, now: clock.now });
    assert(first.state === "handed-back", "a thrown handler ends the run handed-back, not looping");
    assert(first.code === 10, "a handed-back run exits 10");
    assert(
      (calls.ready ?? 0) === 1 && (calls.specify ?? 0) === 1,
      "the steps before the crash ran once",
    );
    assert((calls.build ?? 0) === 1, "the crashed step ran once before the run ended");
    const afterCrash = loadRun(dir, 9);
    assert(
      afterCrash !== undefined &&
        afterCrash.steps.some((s) => s.state === "build" && s.outcome?.kind === "error"),
      "the crashed step is recorded with an error outcome, not left blank",
    );

    // A resume of a run the engine itself ended is not a re-drive: the run is
    // terminal, so nothing runs. This is the property that makes a second
    // `/work-lean` on a finished issue free.
    const second = await runLean({ repoRoot: dir, issue: 9, handlers, now: clock.now });
    assert(
      second.state === "handed-back",
      "re-driving a terminal run reports the same terminal state",
    );
    assert(
      (calls.ready ?? 0) === 1 && (calls.build ?? 0) === 1,
      "a terminal run re-runs no handler at all",
    );
  } finally {
    cleanup();
  }
}

// ── a genuine mid-step crash: no outcome on disk, then a resume ────────────

{
  const { dir, cleanup } = tempDir();
  try {
    // Drive to `build`, then write a state file by hand that has a build step
    // with NO outcome: the exact bytes a process leaves behind when it dies
    // between the write-ahead and the outcome. Hand-building it is the point —
    // going through the engine would record the outcome the crash prevented.
    const seed: LeanRun = {
      schema: 1,
      issue: 11,
      version: "test",
      models: {},
      baseSha: "base",
      branch: "feature/issue-11",
      state: "build",
      counters: {
        buildAttempts: 0,
        challengeDone: false,
        reviewDone: false,
        ciFixUsed: false,
        draft: false,
      },
      steps: [
        {
          key: "11:ready:0",
          state: "ready",
          startedAt: CLOCK,
          endedAt: CLOCK,
          outcome: { kind: "ok" },
        },
        {
          key: "11:specify:0",
          state: "specify",
          startedAt: CLOCK,
          endedAt: CLOCK,
          outcome: { kind: "ok" },
        },
        { key: "11:build:0", state: "build", startedAt: CLOCK },
      ],
    };
    mkdirSync(path.dirname(leanStateFile(dir, 11)), { recursive: true });
    writeFileSync(leanStateFile(dir, 11), JSON.stringify(seed, null, 2), "utf8");

    const { handlers, calls } = scripted(HAPPY);
    const clock = ticking();
    const result = await runLean({ repoRoot: dir, issue: 11, handlers, now: clock.now });
    assert(result.state === "landed", "a resume from a mid-step crash completes the run");
    assert(calls.build === 1, "the crashed build step is re-run exactly once");
    assert(
      calls.ready === undefined && calls.specify === undefined,
      "completed steps are NOT re-run on resume",
    );
    const resumed = loadRun(dir, 11);
    const buildSteps = resumed?.steps.filter((s) => s.state === "build") ?? [];
    assert(
      buildSteps.length === 1,
      "the re-run reuses the crashed step rather than appending a second one",
    );
    assert(
      buildSteps[0]?.startedAt === CLOCK && buildSteps[0]?.endedAt !== undefined,
      "the re-run keeps the original startedAt and adds an endedAt",
    );
    assert(
      resumed?.state === "landed" && resumed.result?.code === 0,
      "the resumed run persists its terminal result",
    );
  } finally {
    cleanup();
  }
}

// The verdict lives in the module the shared `assert` writes to, so the two
// halves of this suite exit the same way for the same reason.
process.exit(failures());
