#!/usr/bin/env bun
/**
 * lean/engine — the runner, against a real state file.
 *
 * Split from `test-lean-engine-crash.ts` for the 500-line gate (AGENTS.md
 * §12). This half drives a run END TO END: the happy path, the refusal path
 * (posted and unposted), the seed, and the two ways a run is refused rather
 * than started (no handler, a corrupt state file). The crash/resume half — the invariant the
 * step log exists for — is its own file.
 *
 * Every case drives `runLean` through a temp directory and asserts on the
 * bytes on disk and the CALL COUNTS a resumed run produced, not on a returned
 * object: a single in-memory run would happily fake both.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runLean } from "../src/lean/engine.ts";
import type { LeanRun } from "../src/lean/state.ts";
import { INITIAL_COUNTERS, leanStateFile, loadRun } from "../src/lean/state.ts";
import { CLOCK, HAPPY, makeAssert, scripted, seedUpTo, tempDir, ticking } from "./lib/lean-engine-fixtures.ts";

const { assert, failures } = makeAssert();

// ── a full run to landed ───────────────────────────────────────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    const { handlers, calls } = scripted(HAPPY);
    const clock = ticking();
    const result = await runLean({
      repoRoot: dir,
      issue: 42,
      handlers,
      now: clock.now,
      seed: { version: "test" },
    });
    assert(result.state === "landed", "a green run lands");
    assert(result.code === 0, "a landed run exits 0");
    assert(result.run.result?.reason === "merged", "the result records why it ended");
    assert(calls.build === 1 && calls.verify === 1, "the happy path builds and verifies once each");

    // The file on disk is the deliverable, not the returned object.
    const onDisk = JSON.parse(readFileSync(leanStateFile(dir, 42), "utf8")) as LeanRun;
    assert(onDisk.schema === 1, "the state file carries the schema version");
    assert(
      onDisk.issue === 42 && onDisk.version === "test",
      "the file identifies its issue and version",
    );
    assert(onDisk.state === "landed", "the file records the terminal state");
    assert(
      onDisk.steps.every((s) => s.outcome !== undefined),
      "every step on disk has an outcome",
    );
    assert(
      onDisk.steps.every((s) => s.startedAt >= CLOCK),
      "startedAt comes from the injected clock, not the wall clock",
    );
    assert(
      onDisk.steps.every((s) => s.endedAt !== undefined && s.endedAt >= s.startedAt),
      "every finished step carries an endedAt at or after its startedAt",
    );
    assert(
      onDisk.steps.every((s) => s.key === `42:${s.state}:${s.key.split(":").pop()}`),
      "every step key is issue:state:attempt",
    );
  } finally {
    cleanup();
  }
}

// ── a run to not-ready ─────────────────────────────────────────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    const { handlers, calls } = scripted({
      ...HAPPY,
      ready: [{ kind: "fail", failedRules: ["no pi-spec v1 block", "size L — split it"] }],
    });
    const clock = ticking();
    const result = await runLean({ repoRoot: dir, issue: 7, handlers, now: clock.now });
    assert(result.state === "not-ready", "a failed ready ends not-ready");
    assert(result.code === 11, "not-ready exits 11");
    assert(
      result.run.result?.reason === "no pi-spec v1 block; size L — split it",
      "the failed rules are the reason, joined for the summary line",
    );
    assert(calls.decline === 1, "the refusal was reported once");
    assert(
      loadRun(dir, 7)?.steps.some((s) => s.state === "decline" && s.outcome?.kind === "done") ===
        true,
      "the reporting step carries the outcome that says the comment went out",
    );
    const reloaded = loadRun(dir, 7);
    assert(reloaded?.state === "not-ready", "the terminal state survives a reload");

    // Resuming a finished refusal does nothing at all: no handler, no second
    // comment. This is the property the terminal/ handler split bought — the
    // engine needs no "not-ready is special" rule to get it.
    const again = await runLean({ repoRoot: dir, issue: 7, handlers, now: clock.now });
    assert(again.state === "not-ready" && again.code === 11, "a re-drive reads the verdict back");
    assert(calls.decline === 1, "and a re-drive posts nothing new");
    assert(calls.ready === 1, "nor does it re-judge a verdict it already earned");
  } finally {
    cleanup();
  }
}

// ── a comment that never posted is still a refusal, and is not retried ────

{
  const { dir, cleanup } = tempDir();
  try {
    const { handlers, calls } = scripted({
      ...HAPPY,
      ready: [{ kind: "fail", failedRules: ["no pi-spec v1 block"] }],
      decline: [{ kind: "report-failed", reason: "comment not posted: connection reset" }],
    });
    const clock = ticking();
    const result = await runLean({ repoRoot: dir, issue: 8, handlers, now: clock.now });
    assert(calls.decline === 1, "the failed post is attempted once and not retried");
    assert(result.state === "not-ready", "a failed post does not change the verdict");
    assert(
      result.code === 11,
      `nor the exit code — the run WAS refused, comment or not (got ${result.code})`,
    );
    assert(
      (result.run.result?.reason ?? "").includes("comment not posted: connection reset"),
      `the reason says the comment never posted (got: ${result.run.result?.reason})`,
    );
    const stored = loadRun(dir, 8);
    assert(
      stored?.steps.some((s) => s.state === "decline" && s.outcome?.kind === "report-failed") ===
        true,
      "the step log records the attempt it made rather than a post that never happened",
    );

    // And the record is durable: a later drive sees a finished run and asks
    // the forge nothing, because a failed post is history, not a debt.
    const again = await runLean({ repoRoot: dir, issue: 8, handlers, now: clock.now });
    assert(again.code === 11, "resuming a finished not-ready run is a free read");
    assert(calls.decline === 1, "and the failed post is not retried on resume");
  } finally {
    cleanup();
  }
}

// ── a missing handler ends the run rather than hanging on it ───────────────

{
  const { dir, cleanup } = tempDir();
  try {
    seedUpTo(dir, 13, "review");
    const { handlers } = scripted(HAPPY);
    handlers.review = undefined;
    const clock = ticking();
    const result = await runLean({ repoRoot: dir, issue: 13, handlers, now: clock.now });
    assert(result.state === "handed-back", "a state with no handler hands back");
    assert(
      result.run.result?.reason === "no handler for state review",
      `it names the state that had no handler (got: ${result.run.result?.reason})`,
    );
  } finally {
    cleanup();
  }
}

// ── an outcome the table does not list is a handler bug, not a run failure ─

{
  const { dir, cleanup } = tempDir();
  try {
    seedUpTo(dir, 15, "verify");
    const { handlers } = scripted(HAPPY);
    handlers.verify = async () => ({ kind: "maybe" });
    const clock = ticking();
    const result = await runLean({ repoRoot: dir, issue: 15, handlers, now: clock.now });
    assert(result.state === "handed-back", "an unlisted outcome ends the run handed-back");
    assert(
      result.run.result?.reason === 'no transition for verify + "maybe"',
      `the reason names the state and the kind the table has no rule for (got: ${result.run.result?.reason})`,
    );
  } finally {
    cleanup();
  }
}

// ── the step cap: a table that looped on its own bug could not spin forever ─

{
  const { dir, cleanup } = tempDir();
  try {
    // build + exhausted publishes a draft, and a draft-bearing build again
    // hands back, so a legal run is short. maxSteps is the net under a table
    // bug, and it is asserted to fire rather than assumed.
    const { handlers } = scripted({
      ready: [{ kind: "ok" }],
      specify: [{ kind: "ok" }],
      build: [{ kind: "ok" }, { kind: "ok" }, { kind: "ok" }],
      challenge: [{ kind: "none" }, { kind: "none" }, { kind: "none" }],
      verify: [{ kind: "green" }, { kind: "green" }, { kind: "green" }],
      publish: [{ kind: "ok" }, { kind: "ok" }, { kind: "ok" }],
      review: [{ kind: "done" }, { kind: "done" }, { kind: "done" }],
      ci: [{ kind: "green" }],
      land: [{ kind: "merged" }],
      handback: [{ kind: "done" }],
    });
    const clock = ticking();
    const result = await runLean({
      repoRoot: dir,
      issue: 17,
      handlers,
      now: clock.now,
      maxSteps: 3,
    });
    assert(result.state === "handed-back", "the step cap stops a run that has not terminated");
    assert(
      result.run.result !== undefined && result.run.result.reason.startsWith("step cap 3 reached"),
      "the reason says the cap fired and where",
    );
  } finally {
    cleanup();
  }
}

// ── the seed only applies to a run that does not exist yet ─────────────────

{
  const { dir, cleanup } = tempDir();
  try {
    const { handlers } = scripted(HAPPY);
    const clock = ticking();
    await runLean({
      repoRoot: dir,
      issue: 19,
      handlers,
      now: clock.now,
      seed: {
        version: "9.9.9",
        models: { build: "model-a" },
        baseSha: "abc",
        branch: "feature/issue-19",
      },
    });
    const stored = loadRun(dir, 19);
    assert(
      stored?.version === "9.9.9" && stored.models.build === "model-a",
      "the seed lands on a new run",
    );
    assert(
      stored?.baseSha === "abc" && stored.branch === "feature/issue-19",
      "baseSha and branch come from the seed",
    );
    const second = await runLean({
      repoRoot: dir,
      issue: 19,
      handlers,
      now: clock.now,
      seed: { version: "other", baseSha: "other", branch: "other" },
    });
    assert(
      second.run.version === "9.9.9" && second.run.baseSha === "abc",
      "a seed never overwrites an existing run",
    );
  } finally {
    cleanup();
  }
}

// ── a corrupt state file is refused loudly, never silently restarted ───────

{
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.dirname(leanStateFile(dir, 21)), { recursive: true });
    writeFileSync(leanStateFile(dir, 21), JSON.stringify({ schema: 7, issue: 21 }), "utf8");
    let thrown: unknown;
    try {
      await runLean({ repoRoot: dir, issue: 21, handlers: scripted(HAPPY).handlers });
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof Error, "an unknown schema throws rather than starting a fresh run");
    assert(/schema/.test((thrown as Error).message), "the error names the schema as the problem");
  } finally {
    cleanup();
  }
}

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
      { key: "23:ready:0", state: "ready", startedAt: CLOCK, endedAt: CLOCK, outcome: { kind: "ok" } },
      {
        key: "23:specify:0",
        state: "specify",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "ok" },
      },
      { key: "23:build:0", state: "build", startedAt: CLOCK, endedAt: CLOCK, outcome: { kind: "ok" } },
      {
        key: "23:challenge:0",
        state: "challenge",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "none" },
      },
      // Index 4 — the last verdict the run's own gate returned. Cases below
      // swap its `kind` and the counters to drive the two halves of the gate.
      {
        key: "23:verify:0",
        state: "verify",
        startedAt: CLOCK,
        endedAt: CLOCK,
        outcome: { kind: "red" },
      },
      { key: "23:publish:0", state: "publish", startedAt: CLOCK, endedAt: CLOCK, outcome: { kind: "ok" } },
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

// ── a hand-corrupted step key is refused at load, not driven ───────────────

{
  // Two steps sharing one key lets the replay path pick either, so a run can
  // replay a verdict for a step it never ran. `loadRun` refuses the file.
  const { dir, cleanup } = tempDir();
  try {
    mkdirSync(path.dirname(leanStateFile(dir, 25)), { recursive: true });
    writeFileSync(
      leanStateFile(dir, 25),
      JSON.stringify(
        {
          schema: 1,
          issue: 25,
          version: "test",
          models: {},
          baseSha: "base",
          branch: "b",
          state: "build",
          counters: { ...INITIAL_COUNTERS },
          steps: [
            { key: "5:build:0", state: "build", startedAt: CLOCK, endedAt: CLOCK, outcome: { kind: "ok" } },
            { key: "5:build:0", state: "build", startedAt: CLOCK },
          ],
        },
        null,
        2,
      ),
      "utf8",
    );
    let thrown: unknown;
    try {
      await runLean({ repoRoot: dir, issue: 25, handlers: scripted(HAPPY).handlers });
    } catch (err) {
      thrown = err;
    }
    assert(thrown instanceof Error, "a duplicated step key is refused rather than driven");
    assert(
      /duplicate step key/.test((thrown as Error).message),
      `the error names the duplicate key (got: ${(thrown as Error).message})`,
    );

    // A key with no readable `:N` would otherwise read as attempt 0 and
    // collide with the state's real first step.
    writeFileSync(
      leanStateFile(dir, 25),
      JSON.stringify(
        {
          schema: 1,
          issue: 25,
          version: "test",
          models: {},
          baseSha: "base",
          branch: "b",
          state: "build",
          counters: { ...INITIAL_COUNTERS },
          steps: [{ key: "5:build:x", state: "build", startedAt: CLOCK }],
        },
        null,
        2,
      ),
      "utf8",
    );
    let suffixErr: unknown;
    try {
      await runLean({ repoRoot: dir, issue: 25, handlers: scripted(HAPPY).handlers });
    } catch (err) {
      suffixErr = err;
    }
    assert(
      suffixErr instanceof Error && /numeric :N suffix/.test(suffixErr.message),
      `a malformed step key suffix is refused (got: ${(suffixErr as Error).message})`,
    );
  } finally {
    cleanup();
  }
}

process.exit(failures());
