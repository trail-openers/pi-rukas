/**
 * lean/engine — resume integrity and the concurrency guarantee.
 *
 * Both cases exist because the engine used to trust what it was handed:
 *
 *   - `runLean` drove from `loadRun(...).state`, and state.ts's own header
 *     calls that field a CACHE — "not trusted as truth; `steps` is the
 *     record". A file whose newest `ci` step was `red` but whose snapshot said
 *     `ci` replayed the older `ci:green` and MERGED: the replay path applies
 *     recorded outcomes without running their handlers, so the merge handler
 *     ran on a verdict the log no longer held.
 *   - two drives on one issue in one process both ran every handler, `land`
 *     included, because nothing said "one run per issue".
 *
 * So the position is now DERIVED by folding the step log through the table,
 * and a file whose snapshot the fold cannot reproduce is refused rather than
 * repaired. And every drive holds a per-issue lock for its whole life.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runLean } from "../src/lean/engine.ts";
import type { LeanRun, Outcome } from "../src/lean/state.ts";
import { INITIAL_COUNTERS, leanStateFile, loadRun } from "../src/lean/state.ts";
import {
  CLOCK,
  HAPPY,
  makeAssert,
  scripted,
  tempDir,
  ticking,
} from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

const STEP = (issue: number, state: string, n: number, kind: string) => ({
  key: `${issue}:${state}:${n}`,
  state,
  startedAt: CLOCK,
  endedAt: CLOCK,
  outcome: { kind },
});

/** The log of a run that built once, was reviewed, and whose CI said green. */
function forgedCiRed(dir: string, issue: number): void {
  mkdirSync(path.dirname(leanStateFile(dir, issue)), { recursive: true });
  const seed = {
    schema: 1,
    issue,
    version: "test",
    models: {},
    baseSha: "base",
    branch: `feature/issue-${issue}`,
    // The snapshot claims the run still sits at `ci`, and its newest `ci`
    // step — index 8 — says RED. Replaying the older `ci:0 = green` is what
    // used to walk this into the merge.
    state: "ci",
    counters: {
      ...INITIAL_COUNTERS,
      // The counters the table itself reaches after this exact log — see the
      // comment on `steps`: the log is a walk, so its counters are derivable.
      buildAttempts: 4,
      challengeDone: true,
      reviewDone: true,
      ciFixUsed: true,
      draft: false,
    },
    steps: [
      STEP(issue, "ready", 0, "ok"),
      STEP(issue, "specify", 0, "ok"),
      STEP(issue, "build", 0, "ok"),
      STEP(issue, "challenge", 0, "none"),
      {
        key: `${issue}:verify:0`,
        state: "verify",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "red" },
      },
      {
        key: `${issue}:build:1`,
        state: "build",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      {
        key: `${issue}:challenge:1`,
        state: "build",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      {
        key: `${issue}:verify:1`,
        state: "verify",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "green" },
      },
      {
        key: `${issue}:publish:0`,
        state: "publish",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      {
        key: `${issue}:review:0`,
        state: "review",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "done" },
      },
      STEP(issue, "ci", 0, "green"),
      {
        key: `${issue}:build:2`,
        state: "build",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      {
        key: `${issue}:build:3`,
        state: "build",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      {
        key: `${issue}:verify:2`,
        state: "verify",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "green" },
      },
      {
        key: `${issue}:publish:1`,
        state: "publish",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      {
        key: `${issue}:review:1`,
        state: "review",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "done" },
      },
      STEP(issue, "ci", 1, "red"),
    ],
  };
  writeFileSync(leanStateFile(dir, issue), JSON.stringify(seed, null, 2), "utf8");
}

// ── the adversary's file: refused at load, and no handler runs ─────────────

{
  const { dir, cleanup } = tempDir();
  try {
    forgedCiRed(dir, 41);
    const { handlers, calls } = scripted(HAPPY);
    let thrown: unknown;
    try {
      await runLean({ repoRoot: dir, issue: 41, handlers, now: ticking().now });
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && thrown.name === "LeanStateError",
      `the forged file is refused with a LeanStateError (got: ${String(thrown)})`,
    );
    assert(
      /snapshot disagrees with the step log/.test((thrown as Error)?.message ?? ""),
      `the error names the disagreement (got: ${(thrown as Error)?.message})`,
    );
    assert(
      (thrown as Error)?.message.includes(leanStateFile(dir, 41)),
      "the error names the file it refused",
    );
    assert(
      Object.keys(calls).length === 0,
      `no handler ran on a refused run (calls: ${JSON.stringify(calls)})`,
    );
    const before = readFileSync(leanStateFile(dir, 41), "utf8");
    forgedCiRed(dir, 41);
    assert(
      readFileSync(leanStateFile(dir, 41), "utf8") === before,
      "refusing never repairs or rewrites the file — the record is byte-identical",
    );
  } finally {
    cleanup();
  }
}

// ── a log the table can reproduce resumes exactly as before ────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.dirname(leanStateFile(dir, 42)), { recursive: true });
    const seed = {
      schema: 1,
      issue: 42,
      version: "test",
      models: {},
      baseSha: "base",
      branch: "feature/issue-42",
      state: "ci",
      counters: {
        ...INITIAL_COUNTERS,
        buildAttempts: 1,
        challengeDone: true,
        reviewDone: true,
      },
      steps: [
        STEP(42, "ready", 0, "ok"),
        STEP(42, "specify", 0, "ok"),
        STEP(42, "build", 0, "ok"),
        STEP(42, "challenge", 0, "none"),
        STEP(42, "verify", 0, "green"),
        STEP(42, "publish", 0, "ok"),
        STEP(42, "review", 0, "done"),
        // No `ci` step: the snapshot says the run sits at `ci` and owes it, so
        // the drive runs that one handler and lands. The fold must reproduce
        // exactly this position rather than one step further.
      ],
    };
    writeFileSync(leanStateFile(dir, 42), JSON.stringify(seed, null, 2), "utf8");
    const { handlers, calls } = scripted(HAPPY);
    const result = await runLean({ repoRoot: dir, issue: 42, handlers, now: ticking().now });
    assert(
      result.state === "landed" && result.code === 0,
      `a consistent log resumes and lands (got ${result.state} exit ${result.code})`,
    );
    assert(
      calls.ready === undefined && calls.verify === undefined,
      "a resume re-runs no completed step",
    );
    assert(calls.land === 1, "and runs exactly the step the log still owed");
  } finally {
    cleanup();
  }
}

// ── an outcome-less trailing verify does not block a green land ────────────

{
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.dirname(leanStateFile(dir, 43)), { recursive: true });
    const seed: LeanRun = {
      schema: 1,
      issue: 43,
      version: "test",
      models: {},
      baseSha: "base",
      branch: "feature/issue-43",
      state: "ci",
      counters: {
        ...INITIAL_COUNTERS,
        buildAttempts: 1,
        challengeDone: true,
        reviewDone: true,
      },
      steps: [
        STEP(43, "ready", 0, "ok"),
        STEP(43, "specify", 0, "ok"),
        STEP(43, "build", 0, "ok"),
        STEP(43, "challenge", 0, "none"),
        STEP(43, "verify", 0, "green"),
        STEP(43, "publish", 0, "ok"),
        STEP(43, "review", 0, "done"),
        // A crash mid-second-verify: written ahead, never finished. It says
        // nothing, so it must not read as "the run's gate never went green".
        { key: "43:verify:1", state: "verify", startedAt: CLOCK },
      ] as LeanRun["steps"],
    };
    writeFileSync(leanStateFile(dir, 43), JSON.stringify(seed, null, 2), "utf8");
    const { handlers, calls } = scripted(HAPPY);
    const result = await runLean({ repoRoot: dir, issue: 43, handlers, now: ticking().now });
    assert(
      result.state === "landed" && result.code === 0 && calls.land === 1,
      `an outcome-less trailing verify does not refuse a green land (got ${result.state}: ${result.run.result?.reason})`,
    );
  } finally {
    cleanup();
  }
}

// ── one run per issue: two concurrent drives, one winner ───────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    const { handlers, calls } = scripted(HAPPY);
    const both = await Promise.allSettled([
      runLean({ repoRoot: dir, issue: 44, handlers, now: ticking().now }),
      runLean({ repoRoot: dir, issue: 44, handlers, now: ticking().now }),
    ]);
    const won = both.filter((r) => r.status === "fulfilled");
    const refused = both.filter(
      (r) =>
        r.status === "rejected" &&
        /run already in progress/.test((r as PromiseRejectedResult).reason?.message ?? ""),
    );
    assert(
      won.length === 1 && refused.length === 1,
      `exactly one drive completed and the other refused (won ${won.length}, refused ${refused.length})`,
    );
    assert(
      won[0]?.status === "fulfilled" && won[0].value.state === "landed",
      "the winning drive ran the run to landed",
    );
    assert(
      calls.land === 1,
      `the merge handler ran exactly once across two concurrent drives (got ${calls.land})`,
    );
    assert(calls.ready === 1, `the whole table ran once, not twice (ready calls ${calls.ready})`);
    assert(
      loadRun(dir, 44)?.state === "landed",
      "the loser's refusal left the winner's record intact",
    );
    // And the lock is released: a later drive on the same issue is not wedged.
    const after = await runLean({ repoRoot: dir, issue: 44, handlers, now: ticking().now });
    assert(
      after.state === "landed" && calls.land === 1,
      "the lock is released in a finally, so the issue is not wedged",
    );
  } finally {
    cleanup();
  }
}

// ── a stale lock (a killed drive's residue) does not wedge the issue ───────

{
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.dirname(leanStateFile(dir, 45)), { recursive: true });
    // A pid no process can own: the bytes a killed drive left behind.
    writeFileSync(`${leanStateFile(dir, 45)}.lock`, "4294967200\n", "utf8");
    const { handlers } = scripted(HAPPY);
    const result = await runLean({ repoRoot: dir, issue: 45, handlers, now: ticking().now });
    assert(
      result.state === "landed",
      `a stale lock is cleared and the run proceeds (got ${result.state}: ${result.run.result?.reason})`,
    );
  } finally {
    cleanup();
  }
}

// ── a live lock is refused by name, and nothing runs ──────────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.dirname(leanStateFile(dir, 46)), { recursive: true });
    writeFileSync(`${leanStateFile(dir, 46)}.lock`, `${process.pid}\n`, "utf8");
    const { handlers, calls } = scripted(HAPPY);
    let thrown: unknown;
    try {
      await runLean({ repoRoot: dir, issue: 46, handlers, now: ticking().now });
    } catch (err) {
      thrown = err;
    }
    assert(
      thrown instanceof Error && /run already in progress \(pid \d+\)/.test(thrown.message),
      `a live lock is refused with the owner's pid (got: ${String(thrown)})`,
    );
    assert(Object.keys(calls).length === 0, "a refused drive runs no handler at all");
  } finally {
    cleanup();
  }
}

process.exit(failures());
