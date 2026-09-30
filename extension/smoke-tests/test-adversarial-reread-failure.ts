#!/usr/bin/env bun
/**
 * #859 — a FAILED ref-range re-read on rounds 2+ must be VISIBLE in the
 * loop's final result, not a silent review of the stale diff.
 *
 * The recompute closure used to map every `!ok` result to `""`, which the
 * round loop silently ignores (keeps the previous diff) — so an empty range,
 * an over-cap diff, or an unreadable ref all left rounds 2+ reviewing the
 * STALE diff with no signal. Now the recompute throws the reason, the loop
 * traces it AND records a `note: round <n> diff re-read failed (<reason>)`
 * line that lands in the final result text.
 *
 * This drives the REAL `runAdversarialLoop` (not a copy of the closure) with
 * `base` + `head` on a scratch git repo: the round-1 reviewer returns a
 * non-approving verdict, the fix phase makes the range EMPTY (the fixer's own
 * committed work is exactly what the range measured, so a full revert of it
 * leaves `base...head` with nothing to show) — so the round-2 recompute fails
 * with the "empty diff" reason. The final result must carry the note line,
 * and the round-2 reviewer must still have been prompted with the round-1
 * (stale) diff — the keep-previous-diff behaviour is preserved.
 *
 * The spawn seam is mocked the way test-adversarial-range-recompute.ts does
 * (mock.module before the src import, module-level responder, prompt
 * capture) so no real child process is spawned; the git repo is real, so the
 * recompute goes through the real `computeRangeDiff`.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "bun:test";

// Debug must be ON before adversarial.ts is imported: trace.ts reads
// PI_ENSEMBLE_DEBUG at module load, and the re-read trace only lands when it
// was on at import time (the env set later in the test would be too late).
const priorDebug = process.env.PI_ENSEMBLE_DEBUG;
process.env.PI_ENSEMBLE_DEBUG = "1";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/*
 * Module-level responder: the installed `spawnSpecialist` closure reads it on
 * every call. The loop alternates roles per round (review → fix → review), so
 * the responder keys off the role.
 */
type SpawnSpec = { role: string; prompt: string; cwd?: string };
const FIX_MARKER = "original_sample_function";
let spawnResponder: ((spec: SpawnSpec) => unknown) | null = null;
const spawnCalls: Array<{ role: string; tag: string; prompt: string }> = [];
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-859-re",
  spawnSpecialist: async (spec: SpawnSpec, opts?: { tag?: string }) => {
    spawnCalls.push({ role: spec.role, tag: opts?.tag ?? "", prompt: spec.prompt });
    if (spawnResponder) return spawnResponder(spec);
    return {
      role: spec.role,
      ok: true,
      text: "VERDICT: ISSUES_FOUND",
      toolUses: [],
      ms: 10,
      exitCode: 0,
    };
  },
}));
// Deck and orchestrator bookkeeping are not under test. The deck module
// imports pi-tui, so mock it before the src import (spreading the real
// module keeps every named export other importers expect); the orchestrator
// registry mock no-ops the job-table lookups.
const realDeck = await import("../src/dispatch-deck.ts");
mock.module(new URL("../src/dispatch-deck.ts", import.meta.url).href, () => ({
  ...realDeck,
  startEntry: () => {},
  updateEntry: () => {},
  clearBatchEntry: () => {},
  clearEntry: () => {},
  startBatchEntry: () => {},
  updateBatchProgress: () => {},
}));
const realRegistry = await import("../src/async-jobs-registry.ts");
mock.module(new URL("../src/async-jobs-registry.ts", import.meta.url).href, () => ({
  ...realRegistry,
  childHandles: new Map(),
  registerChildHandle: () => {},
  setOrchestratorActiveChild: () => {},
  markOrchestrator: () => {},
}));

const { runAdversarialLoop } = await import("../src/adversarial.ts");

// ----------------------------------------------- a real scratch git repo

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });

const repoDir = mkdtempSync(path.join(os.tmpdir(), "adv-reread-859-"));
try {
  // Pin the initial branch to main: a bare `git init` follows the machine's
  // init.defaultBranch (CI runners are not guaranteed to default to main), and
  // the loop's range is `main...feat/round1`.
  git(repoDir, "init", "-q", "-b", "main");
  git(repoDir, "config", "user.email", "t@example.com");
  git(repoDir, "config", "user.name", "test");
  // Base content is a single line. The head branch adds one line carrying
  // the marker — the round-1 diff the loop computes from the ref range.
  const BASE_CONTENT = "line one\n";
  writeFileSync(path.join(repoDir, "src-sample-rs.txt"), BASE_CONTENT);
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "base commit");
  git(repoDir, "checkout", "-qb", "feat/round1");
  writeFileSync(path.join(repoDir, "src-sample-rs.txt"), BASE_CONTENT + FIX_MARKER + "\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "round 1 change");

  const base = "main";
  const head = "feat/round1";

  spawnCalls.length = 0;
  spawnResponder = (spec) => {
    if (spec.role === "developer") {
      // The fix phase: restore the file to the base content and commit on the
      // head branch. After this commit the range base...head is EMPTY (the
      // only change was the round-1 line, now reverted), so every later
      // recompute of the range fails with the "empty diff" reason — the
      // re-read failure the note must make visible.
      const current = readFileSync(path.join(repoDir, "src-sample-rs.txt"), "utf8");
      if (current === BASE_CONTENT) {
        // The range is already empty after an earlier fix; nothing to do.
        // (git has no way to commit "the same content", so no no-op commit.)
        return {
          role: "developer",
          ok: true,
          text: "Nothing left to change; the revert already landed.",
          toolUses: [],
          ms: 10,
          exitCode: 0,
        };
      }
      writeFileSync(path.join(repoDir, "src-sample-rs.txt"), BASE_CONTENT);
      git(repoDir, "add", "-A");
      git(repoDir, "commit", "-q", "-m", "fix: revert the change");
      return {
        role: "developer",
        ok: true,
        text: "Applied the fix.",
        toolUses: [],
        ms: 10,
        exitCode: 0,
      };
    }
    // Reviewer rounds: CRITICAL so the loop spends every round (fix +
    // re-review) and ends REJECTED — the final result is the one the
    // re-read note is appended to.
    return {
      role: spec.role,
      ok: true,
      text: "VERDICT: CRITICAL_ISSUES_FOUND\n\n1. fix the thing",
      toolUses: [],
      ms: 10,
      exitCode: 0,
      transcriptPath: path.join(repoDir, "transcript.json"),
      model: "test-model",
    };
  };

  const priorLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER;
  const priorBranch = process.env.PI_ENSEMBLE_LENS_BRANCH;
  try {
    const result = await runAdversarialLoop(
      { base, head, context: "ctx", workCwd: repoDir },
      new AbortController().signal,
      "job-859-re",
    );

    const reviews = spawnCalls.filter((c) => c.role === "adversarial-developer");
    assert(reviews.length >= 2, "the loop ran at least two review rounds");

    // The keep-previous-diff behaviour: with the range now empty, rounds 2+
    // must STILL be prompted with the round-1 (stale) diff — that is the
    // preserved success-path behaviour the note only annotates.
    assert(
      reviews[1].prompt.includes(FIX_MARKER),
      "round-2 reviewer still prompted with the round-1 (stale) diff — the failed re-read keeps the previous diff",
    );

    assert(
      result.text.includes(
        "note: round 2 diff re-read failed (empty diff for range main...feat/round1 (nothing to review — this is never an approval)) — reviewed the previous diff",
      ),
      "the final result carries the round-2 re-read failure note (naming the reason)",
    );
    assert(
      result.text.includes("note: round 3 diff re-read failed"),
      "the final result carries the round-3 re-read failure note (the failure persists)",
    );
    assert(
      !result.text.includes("note: round 1 diff re-read failed"),
      "round 1 (computed at entry, not re-read) has no note",
    );
    assert(
      !result.ok && result.text.includes("REJECTED after 3 rounds"),
      "the loop still rejects after 3 CRITICAL rounds (fix loop intact)",
    );
  } finally {
    if (priorDebug === undefined) delete process.env.PI_ENSEMBLE_DEBUG;
    else process.env.PI_ENSEMBLE_DEBUG = priorDebug;
    if (priorLedger === undefined) delete process.env.PI_ENSEMBLE_REVIEW_LEDGER;
    else process.env.PI_ENSEMBLE_REVIEW_LEDGER = priorLedger;
    if (priorBranch === undefined) delete process.env.PI_ENSEMBLE_LENS_BRANCH;
    else process.env.PI_ENSEMBLE_LENS_BRANCH = priorBranch;
  }
} finally {
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {}
}

console.log(`\nexit ${exit}`);
process.exit(exit);
