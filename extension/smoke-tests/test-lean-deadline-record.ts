#!/usr/bin/env bun
/**
 * lean/state — the caller's deadline on a durable run record (#1920 item 2).
 *
 * Split from `test-lean-state-outcome.ts` at AGENTS.md §12's line cap, along the
 * seam the field already had: that file judges which step may record which piece
 * of evidence, this one judges the ONE field of the run that belongs to the
 * caller's clock.
 *
 * `deadlineMs` is the clock `driveLoop` re-reads at every boundary, so a corrupt
 * value is not cosmetic: a `0` stops every step and a `"1e18"` stops none, and
 * both would be obeyed before anything looked at them. So the loader holds it to
 * a positive finite epoch ms, and this is the ONE site that does — every
 * `loadRun` passes through `assertRunFile`, which is where `runLean` reads a
 * resumed record. A file written before the field existed simply omits it and
 * loads unchanged, which is the shape a pre-#1920 run has: a resume of one must
 * drive with no clock at all rather than refuse to load.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { INITIAL_COUNTERS, leanStateFile, loadRun } from "../src/lean/state.ts";
import { FIXTURE_BASE_SHA, makeAssert, tempDir } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

/**
 * The caller's deadline, checked at load like every other field the loop acts on.
 *
 * `deadlineMs` is the clock `driveLoop` re-reads at every boundary (#1920 item 2),
 * so a corrupt value is not cosmetic: a `0` stops every step and a `"1e18"` stops
 * none, and both would be obeyed before anything looked at them. So the loader
 * holds it to a positive finite epoch ms, and this is the ONE site that does —
 * every `loadRun` passes through `assertRunFile`, which is where `runLean` reads a
 * resumed record. A file written before the field existed simply omits it and
 * loads unchanged, which is the shape a pre-#1920 run has.
 */
function forgedDeadline(dir: string, issue: number, deadlineMs: unknown): void {
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  const seed = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: FIXTURE_BASE_SHA,
    branch: `feature/issue-${issue}`,
    state: "ready",
    counters: INITIAL_COUNTERS,
    steps: [],
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
  };
  writeFileSync(leanStateFile(dir, issue), JSON.stringify(seed, null, 2), "utf8");
}

for (const [label, issue, deadlineMs] of [
  ["zero", 70, 0],
  ["a negative", 71, -5],
  ["NaN — which JSON writes as null", 72, null],
  ["a string that looks like a number", 73, "1e18"],
  ["an Infinity", 74, "Infinity"],
  // An epoch in SECONDS is positive, finite and greater than zero, so a `> 0`
  // check accepts it — and it names a date in 1970, which every step boundary has
  // already passed, so the run behaves as though its clock had gone BEFORE its
  // first step. `work`'s reader refuses the same value; the two engines must not
  // disagree about whether one record carries a deadline.
  ["an epoch in SECONDS", 77, 1_700_000_000],
  ["one millisecond after the epoch", 78, 1],
] as const) {
  const { dir, cleanup } = tempDir();
  try {
    forgedDeadline(dir, issue, deadlineMs);
    let thrown: unknown;
    try {
      loadRun(dir, issue);
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && thrown.name === "LeanStateError",
      `a hand-edited deadlineMs of ${label} is refused at load (got: ${String(thrown)})`,
    );
    assert(
      /deadlineMs/.test((thrown as Error)?.message ?? ""),
      `the refusal for a deadlineMs of ${label} names the field (got: ${(thrown as Error)?.message})`,
    );
  } finally {
    cleanup();
  }
}

{
  // The two shapes that are NOT corruptions: the arm a real run persisted, and
  // its ABSENCE, which is every record written before #1920 — a resume of one must
  // load unchanged and drive with no clock at all.
  const armed = 1_700_000_000_000;
  for (const [label, issue, deadlineMs] of [
    ["a real arm", 75, armed],
    ["no deadline field at all (a pre-#1920 file)", 76, undefined],
  ] as const) {
    const { dir, cleanup } = tempDir();
    try {
      forgedDeadline(dir, issue, deadlineMs);
      let thrown: unknown;
      let loaded: unknown;
      try {
        loaded = loadRun(dir, issue);
      } catch (err) {
        thrown = err;
      }
      assert(thrown === undefined, `a deadlineMs of ${label} loads (got: ${String(thrown)})`);
      assert(
        (loaded as { deadlineMs?: unknown })?.deadlineMs === (deadlineMs ?? undefined),
        `the loaded record keeps its ${label} (got ${JSON.stringify((loaded as { deadlineMs?: unknown })?.deadlineMs)})`,
      );
    } finally {
      cleanup();
    }
  }
}

process.exit(failures());
