#!/usr/bin/env bun
/**
 * lean/engine — the runner, against a real state file.
 *
 * Split from `test-lean-engine-crash.ts` for the 500-line gate (AGENTS.md
 * §12). This half drives a run END TO END: the happy path, the not-ready
 * path, the seed, and the two ways a run is refused rather than started (no
 * handler, a corrupt state file). The crash/resume half — the invariant the
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
import { leanStateFile, loadRun } from "../src/lean/state.ts";
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
    const { handlers } = scripted({
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
    const reloaded = loadRun(dir, 7);
    assert(reloaded?.state === "not-ready", "the terminal state survives a reload");
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

process.exit(failures());
