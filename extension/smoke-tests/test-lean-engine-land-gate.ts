#!/usr/bin/env bun
/**
 * lean/engine — the land gate, against a hand-written record.
 *
 * Split from `test-lean-engine.ts` for the 500-line gate (AGENTS.md §12); the
 * end-to-end and refusal halves stay there, and the crash/resume half lives in
 * `test-lean-engine-crash.ts`.
 *
 * This file pins the one arrival the engine must never hand out for free. The
 * merge is the irreversible act in a run, and the table alone cannot gate it:
 * `ci + green` is a LEGAL pair for a run whose own gate last said red, because
 * outcomes reach `next()` one at a time and the replay path re-applies a
 * recorded `ci:green` without asking what the log before it recorded. So the
 * check sits on the ARRIVAL, and every case here is judged on whether the
 * merge handler ran.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runLean } from "../src/lean/engine.ts";
import type { LeanRun } from "../src/lean/state.ts";
import { INITIAL_COUNTERS, leanStateFile } from "../src/lean/state.ts";
import {
  CLOCK,
  HAPPY,
  makeAssert,
  scripted,
  tempDir,
  ticking,
} from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

// ── the land gate: a run whose own gate said red never merges ─────────────

{
  // The adversarial shape: a state file whose step log ends with a RED verify
  // followed by a recorded `ci:green`, driven on a fresh process. The engine's
  // replay path applies recorded outcomes without running their handlers, so
  // before the arrival gate this walked straight into `land` — the merge
  // handler — on a run whose own gate had said the work was not verified.
  const { dir, cleanup } = tempDir();
  try {
    const steps = [
      {
        key: "23:ready:0",
        state: "ready",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      {
        key: "23:specify:0",
        state: "specify",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      {
        key: "23:build:0",
        state: "build",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      {
        key: "23:challenge:0",
        state: "challenge",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "none" },
      },
      // Index 5 (the build attempt below the cap has been charged, and its own
      // entry step is the outcome-less one a re-entry always leaves behind).
      { key: "23:build:1", state: "build", startedAt: CLOCK },
      // Index 6 — the last verdict the run's OWN gate returned. The cases
      // below swap its `kind` and the counters to drive each half of the land
      // gate, and it is deliberately NOT followed by a later green: the gate
      // asks what the record's newest verify said. What follows is the walk
      // the table produces from that verdict with every step itemised, so
      // `verifiedPosition` can fold it and the gate is judged on the verdict
      // the record HOLDS rather than on a truncated log (a log that is not a
      // walk is refused at load; see `test-lean-engine-resume.ts`).
      {
        key: "23:verify:0",
        state: "verify",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "red" },
      },
      {
        key: "23:build:2",
        state: "build",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      {
        key: "23:verify:2",
        state: "verify",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "green" },
      },
      {
        key: "23:publish:0",
        state: "publish",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      {
        key: "23:review:0",
        state: "review",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "done" },
      },
      { key: "23:ci:0", state: "ci", startedAt: CLOCK, endedAt: CLOCK, outcome: { kind: "green" } },
    ];
    const baseRun = {
      schema: 1 as const,
      issue: 23,
      version: "test",
      models: {},
      baseSha: "base",
      branch: "feature/issue-23",
      state: "ci" as const,
    };
    const writeSeed = (counters: Partial<LeanRun["counters"]>, verifyKind: string): void => {
      mkdirSync(path.dirname(leanStateFile(dir, 23)), { recursive: true });
      // The two later verify rounds are driven, not recorded, so their kind is
      // a placeholder the drive overwrites — they exist to make the log a walk
      // the fold can reproduce, not to state a verdict.
      const withVerify = steps.map((s) =>
        s.key === "23:verify:0" ? { ...s, outcome: { kind: verifyKind } } : s,
      );
      const seed = {
        ...baseRun,
        // draft true is the honest version of this record: a red verify is
        // what raises the marker. Both halves of the gate are driven below.
        counters: {
          ...INITIAL_COUNTERS,
          buildAttempts: 2,
          challengeDone: true,
          reviewDone: true,
          draft: true,
          ...counters,
        },
        steps: withVerify,
      };
      writeFileSync(leanStateFile(dir, 23), JSON.stringify(seed, null, 2), "utf8");
    };

    writeSeed({ draft: true }, "red");
    const { handlers, calls } = scripted(HAPPY);
    const result = await runLean({ repoRoot: dir, issue: 23, handlers, now: ticking().now });
    assert(result.state === "handed-back", "a replay whose last verify was red does not land");
    assert(result.code === 10, "the refused run exits 10, not 0");
    assert(calls.land === undefined, "the merge handler never ran");
    assert(
      (result.run.result?.reason ?? "").startsWith("land refused: verify not green"),
      `the reason names the refused arrival (got: ${result.run.result?.reason})`,
    );

    // The other half of the gate: the newest verify is green but the marker
    // still says draft — a run that never re-ran its gate after the fix does
    // not merge on a CI green alone.
    writeSeed({ draft: true }, "green");
    const markerOnly = await runLean({ repoRoot: dir, issue: 23, handlers, now: ticking().now });
    assert(
      markerOnly.state === "handed-back" && calls.land === undefined,
      "a run still carrying the draft marker cannot land even with a green verify",
    );

    // The positive control: green verify and no marker is the one record that
    // earns the merge, so the gate above is a filter and not a wall.
    writeSeed({ draft: false }, "green");
    const earned = await runLean({ repoRoot: dir, issue: 23, handlers, now: ticking().now });
    assert(
      earned.state === "landed" && earned.code === 0 && calls.land === 1,
      `green verify and no marker does land (got ${earned.state} exit ${earned.code}, land calls ${calls.land})`,
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());
