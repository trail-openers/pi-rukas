#!/usr/bin/env bun
/**
 * lean/resume — a build the ceiling stopped folds to the round it DISPATCHED
 * (#2067, #2081).
 *
 * `build + budget` bills nothing on the way out — the round was billed on the
 * edge that entered build — so a run killed mid-attempt must still fold to the
 * counters a drive persisted, or `verifiedPosition` refuses an honest file
 * and the run cannot resume at all. Split from test-lean-engine-resume.ts for
 * the 500-line gate (AGENTS.md §12).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runLean } from "../src/lean/engine.ts";
import type { LeanRun, LeanState, Outcome, Step } from "../src/lean/state.ts";
import { INITIAL_COUNTERS, leanStateFile } from "../src/lean/state.ts";
import {
  CLOCK,
  FIXTURE_BASE_SHA,
  HAPPY,
  makeAssert,
  scripted,
  tempDir,
  ticking,
} from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

// ── a build attempt the ceiling stopped folds to the round it billed (#2067) ──
//
// A budget-stopped build leaves `build` on a plain move, so a run killed
// mid-attempt must fold to `buildAttempts` = rounds DISPATCHED, or
// `verifiedPosition` refuses an honest file and the run cannot resume at all.
// The log below is the walk the table produces for one budget round followed by
// a live second attempt, and the snapshot is what the fold derives.
{
  const { dir, cleanup } = tempDir();
  try {
    const issue = 49;
    const budget: Outcome = {
      kind: "budget",
      limit: "turns",
      value: 400,
      used: 401,
      reason: "build stopped: turns budget 400 exceeded (used 401)",
    };
    const step = (state: LeanState, n: number, outcome?: Outcome): Step => ({
      key: `${issue}:${state}:${String(n)}`,
      state,
      startedAt: CLOCK,
      endedAt: CLOCK,
      ...(outcome === undefined ? {} : { outcome }),
    });
    const steps: Step[] = [
      step("ready", 0, { kind: "ok" }),
      step("specify", 0, { kind: "ok" }),
      step("build", 0, budget),
    ];
    // The snapshot the engine would have persisted when it stopped mid-attempt:
    // the gate the stopped round's edge leads to, with that round billed. A
    // snapshot naming `build` is a position the table cannot reach, and resume
    // refuses the file — the failure #2067 must not add.
    const onDisk: LeanRun = {
      schema: 1,
      issue,
      version: "test",
      models: {},
      baseSha: FIXTURE_BASE_SHA,
      branch: `feature/issue-${String(issue)}`,
      state: "challenge",
      counters: { ...INITIAL_COUNTERS, buildAttempts: 1 },
      steps,
    };
    // The fold has to bill the stopped round and carry the run out of `build`,
    // so the log ends at the gate that edge leads to: `challenge`, with nothing
    // owed beyond it. A second `build` row is not a state the table can reach.
    mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
    writeFileSync(leanStateFile(dir, issue), JSON.stringify(onDisk, null, 2), "utf8");
    const { handlers, calls } = scripted({ build: [{ kind: "ok" }], ...HAPPY });
    const res = await runLean({ repoRoot: dir, issue, handlers, now: ticking().now });
    // The field shape this case exists for: the step billed the round the stopped
    // child ran and the run then died before the gate wrote its file. The log's
    // newest row is that billed round with nothing owed beyond it, so resume must
    // fold to the counters a drive persisted rather than refuse the file — #1615's
    // fix for `challenge`, applied to a round the ceiling cut short.
    assert(
      res.run.state === "landed",
      `the run resumed and landed (got ${res.run.state}/${res.run.result?.reason})`,
    );
    assert(
      !/snapshot disagrees/.test(res.run.result?.reason ?? ""),
      `nothing refused the file (got ${res.run.result?.reason})`,
    );
    assert(
      res.run.counters.buildAttempts === 1,
      `the stopped round is billed as the one DISPATCH it was, on the edge that entered build (got ${res.run.counters.buildAttempts})`,
    );
    // Re-entering the step must not charge the round again: the log below has one
    // decided `build:budget` row and the run leaves with one attempt, so a
    // resumed visit that re-billed on entry would land on two and be refused.
    assert(
      res.run.steps.filter((s) => s.state === "build" && s.outcome?.kind === "budget").length === 1,
      "the log carries exactly the one stopped round the counter bills (nothing double-billed)",
    );
    assert(!("build" in calls), `no second build was paid for (got ${String(calls.build ?? 0)})`);
  } finally {
    cleanup();
  }
}

process.exit(failures());
