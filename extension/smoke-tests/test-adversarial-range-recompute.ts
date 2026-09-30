#!/usr/bin/env bun
/**
 * #859 — the base/head ref-range diff must be RECOMPUTED before every
 * review round, so a fix round's committed changes reach the next reviewer.
 *
 * The loop's closure assigned the recompute function to the LOCAL `getDiff`
 * (which is what rounds 2+ use), but the round loop checked and called
 * `params.getDiff` — undefined for the range case, so the diff was never
 * refreshed: rounds 2+ were prompted with the round-1 diff, exactly the
 * staleness #664's reviewer noticed itself.
 *
 * This drives the REAL `runAdversarialLoop` (not a copy of the closure) with
 * `base` + `head` on a scratch git repo: the round-1 reviewer returns a
 * non-approving verdict, the fix phase commits a change on the head branch,
 * and the round-2 reviewer's PROMPT must contain the new change's text.
 *
 * The spawn seam is mocked the way test-lens-skill-wiring.ts does (mock.module
 * before the src import, module-level responder, prompt capture) so no real
 * child process is spawned; the git repo is real, so the recompute goes
 * through the real `computeRangeDiff` (execFile `git diff <base>...<head>`).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "bun:test";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`✓ ${msg}`);
    return true;
  }
  console.error(`✗ ${msg}\n    actual:   ${a}\n    expected: ${e}`);
  exit = 1;
  return false;
}

/*
 * Module-level responder: the installed `spawnSpecialist` closure reads it on
 * every call. The loop alternates roles per round (review → fix → review), so
 * the responder keys off the role + the round in the tag.
 */
type SpawnSpec = { role: string; prompt: string; cwd?: string };
const FIX_MARKER = "fn fixed_by_round_one_marker() {}";
let spawnResponder: ((spec: SpawnSpec) => unknown) | null = null;
let round1FixText = ""; // what the round-1 fix prompt received (canary for the diff hand-off)
const spawnCalls: Array<{ role: string; tag: string; prompt: string }> = [];
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-859",
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
  clearEntry: () => {},
  startBatchEntry: () => {},
  updateBatchProgress: () => {},
  clearBatchEntry: () => {},
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

const repoDir = mkdtempSync(path.join(os.tmpdir(), "adv-range-859-"));
try {
  git(repoDir, "init", "-q");
  git(repoDir, "config", "user.email", "t@example.com");
  git(repoDir, "config", "user.name", "test");
  writeFileSync(path.join(repoDir, "src-sample-rs.txt"), "line one\n");
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "base commit");
  // The head branch carries one real change — the round-1 diff the loop
  // computes from the ref range.
  git(repoDir, "checkout", "-qb", "feat/round1");
  writeFileSync(
    path.join(repoDir, "src-sample-rs.txt"),
    "line one\nline two original_sample_function\n",
  );
  git(repoDir, "add", "-A");
  git(repoDir, "commit", "-q", "-m", "round 1 change");

  const base = "main";
  const head = "feat/round1";

  spawnCalls.length = 0;
  spawnResponder = (spec) => {
    if (spec.role === "developer") {
      // The fix phase: make a REAL change to the source file and commit it on
      // the head branch. The file's content is derived from its own current
      // content, so the commit always differs from the file's pre-fix state
      // (no no-op commits — git has no way to commit "the same content").
      if (!round1FixText) {
        round1FixText = spec.prompt;
        const current = readFileSync(path.join(repoDir, "src-sample-rs.txt"), "utf8");
        writeFileSync(
          path.join(repoDir, "src-sample-rs.txt"),
          `${current.trim()}\nline two ${FIX_MARKER}\n`,
        );
        git(repoDir, "add", "-A");
        git(repoDir, "commit", "-q", "-m", "fix: round one fix");
      }
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
    // re-review) and ends REJECTED — a plain ISSUES_FOUND no longer blocks
    // after 3 rounds (the #664 terminal rule), so the test would see a
    // pass-with-findings instead of the recompute it exists to prove.
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

  const priorDebug = process.env.PI_ENSEMBLE_DEBUG;
  const priorLedger = process.env.PI_ENSEMBLE_REVIEW_LEDGER;
  const priorBranch = process.env.PI_ENSEMBLE_LENS_BRANCH;
  process.env.PI_ENSEMBLE_DEBUG = "1"; // let the re-read trace land where the test can see it
  try {
    const result = await runAdversarialLoop(
      { base, head, context: "ctx", workCwd: repoDir },
      new AbortController().signal,
      "job-859",
    );

    const reviews = spawnCalls.filter((c) => c.role === "adversarial-developer");
    eq(reviews.length >= 2, true, "the loop ran at least two review rounds");

    const round1 = reviews[0];
    assert(
      round1.prompt.includes("original_sample_function") && !round1.prompt.includes(FIX_MARKER),
      "round-1 reviewer prompted with the pre-fix diff",
    );
    assert(
      round1.prompt.includes("CRITICAL_ISSUES_FOUND"),
      "canary: the reviewer prompt carries the verdict menu",
    );

    const round2 = reviews[1];
    assert(
      round2.prompt.includes(FIX_MARKER),
      "ROUND-2 REVIEWER'S PROMPT CONTAINS THE FIX (the ref-range diff was recomputed before round 2)",
    );
    assert(
      round2.prompt.includes("original_sample_function"),
      "...with the original change still in the range (the recompute is the SAME base...head range, refreshed)",
    );
    assert(
      round2.prompt.includes(FIX_MARKER) && round1FixText.includes("original_sample_function"),
      "...the round-1 fix prompt itself had the pre-fix diff (the hand-off to the fixer was intact)",
    );

    eq(
      spawnCalls.filter((c) => c.role === "developer").length,
      2,
      "the fix phase ran for rounds 1 and 2",
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
