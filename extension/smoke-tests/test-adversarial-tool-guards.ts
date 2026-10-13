#!/usr/bin/env bun
/**
 * #1104 — the adversarial_loop tool path's guards.
 *
 *   - reportOnly: exactly one reviewer, zero developers, zero file changes;
 *     verdict + ledger entry still recorded.
 *   - workCwd gate: a fix needed with no workCwd stops BEFORE any developer
 *     spawn, returns the verdict (naming workCwd) and records the ledger entry.
 *   - every fix-developer spawn carries cwd === workCwd.
 *   - the caller repository's `git status --porcelain` is snapshotted around
 *     each fix round; a change there is reported as a violation.
 *
 * Drives the REAL runAdversarialLoop with fixFence (what the tool
 * passes) over real scratch git repos. The spawn seam, the ledger writer and
 * the deck/registry bookkeeping are mocked (same seams as
 * test-adversarial-range-recompute.ts).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

type SpawnSpec = { role: string; prompt: string; cwd?: string };
// Reviewer verdicts in order; the last one repeats once the queue is empty.
let reviewerReplies: string[] = [];
let developerWrite: ((cwd: string) => void) | null = null;
// How many developer dispatches fail (crash, no verdict) before they succeed.
let devFailures = 0;
// The next fix dispatch writes (via developerWrite) and then throws (#1104 r3).
let devThrow = false;
const spawnCalls: Array<{ role: string; cwd?: string }> = [];
const ledgerResults: Array<{ loopOutcome?: string; text: string }> = [];

mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-1104",
  spawnSpecialist: async (spec: SpawnSpec) => {
    spawnCalls.push({ role: spec.role, cwd: spec.cwd });
    if (spec.role === "developer") {
      if (devThrow) {
        devThrow = false;
        developerWrite?.(spec.cwd ?? process.cwd());
        throw new Error("spawn exploded");
      }
      if (devFailures > 0) {
        devFailures--;
        return { role: "developer", ok: false, text: "", toolUses: [], ms: 1, exitCode: 1 };
      }
      developerWrite?.(spec.cwd ?? process.cwd());
      return { role: "developer", ok: true, text: "Applied.", toolUses: [], ms: 1, exitCode: 0 };
    }
    const text = reviewerReplies.length > 1 ? reviewerReplies.shift() : reviewerReplies[0];
    if (text === undefined) throw new Error("test mock: no reviewer reply queued");
    return { role: spec.role, ok: true, text, toolUses: [], ms: 1, exitCode: 0 };
  },
}));
const realLedger = await import("../src/adversarial-ledger.ts");
mock.module(new URL("../src/adversarial-ledger.ts", import.meta.url).href, () => ({
  ...realLedger,
  writeAdversarialLedgerEntry: (r: { loopOutcome?: string; text: string }) => {
    ledgerResults.push({ loopOutcome: r.loopOutcome, text: r.text });
  },
}));
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

const APPROVED = "VERDICT: APPROVED\n\nlooks good";
const ISSUES = "VERDICT: CRITICAL_ISSUES_FOUND\n\n1. fix the thing";

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
const newRepo = (tag: string) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `adv-1104-${tag}-`));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "test");
  writeFileSync(path.join(dir, "f.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
};
const signal = () => new AbortController().signal;
const reset = () => {
  spawnCalls.length = 0;
  ledgerResults.length = 0;
  developerWrite = null;
  devFailures = 0;
  devThrow = false;
};

const callerRepo = newRepo("caller");
// The fence requires workCwd to be a worktree of the caller's repository (#1104 r2).
const workBase = mkdtempSync(path.join(os.tmpdir(), "adv-1104-wt-"));
const workRepo = path.join(workBase, "wt");
git(callerRepo, "worktree", "add", "-q", "-b", "wt-1104", workRepo);
const priorCwd = process.cwd();
try {
  // ---------------------------------------------------------------- A. reportOnly
  reset();
  reviewerReplies = [ISSUES];
  const a = await runAdversarialLoop(
    {
      diff: "diff --git a/f b/f\n+x",
      context: "ro",
      workCwd: workRepo,
      reportOnly: true,
    },
    signal(),
    "job-a",
  );
  assert(
    spawnCalls.filter((c) => c.role === "adversarial-developer").length === 1,
    "A: reportOnly dispatches exactly one reviewer",
  );
  assert(
    spawnCalls.filter((c) => c.role === "developer").length === 0,
    "A: reportOnly dispatches zero fix-developers",
  );
  assert(
    git(workRepo, "status", "--porcelain").toString() === "",
    "A: reportOnly changes zero files",
  );
  assert(a.adversarialRounds?.length === 1, "A: the verdict is carried in the result");
  assert(
    ledgerResults.length === 1 && ledgerResults[0]?.loopOutcome === "rejected",
    "A: ledger entry written (rejected)",
  );

  // ------------------------------------------------ B. no workCwd → gate before fix
  reset();
  reviewerReplies = [ISSUES];
  const b = await runAdversarialLoop(
    { diff: "diff --git a/f b/f\n+x", context: "gate", fixFence: { callerCwd: callerRepo } },
    signal(),
    "job-b",
  );
  assert(
    spawnCalls.filter((c) => c.role === "developer").length === 0,
    "B: no fix-developer spawned without workCwd",
  );
  assert(b.ok === false && b.text.includes("workCwd"), "B: result is an error naming workCwd");
  assert(b.loopOutcome === "invalid-input", "B: a missing workCwd is invalid-input, not rejected");
  assert(b.text.includes("CRITICAL_ISSUES_FOUND"), "B: the review verdict is still returned");
  assert(
    ledgerResults.length === 1 && ledgerResults[0]?.text.includes("workCwd"),
    "B: ledger entry recorded for the gated run",
  );
  reset();
  reviewerReplies = [ISSUES];
  const b2 = await runAdversarialLoop(
    { diff: "diff --git a/f b/f\n+x", context: "gate" },
    signal(),
    "job-b2",
  );
  assert(
    spawnCalls.filter((c) => c.role === "developer").length === 0 && b2.ok === false,
    "B: the workCwd gate also applies on the driver path (no fixFence)",
  );

  // ------------------------------- C. fix round in workCwd: every developer cwd === workCwd
  reset();
  reviewerReplies = [ISSUES, APPROVED];
  developerWrite = (cwd) => writeFileSync(path.join(cwd, "f.txt"), "one\nfixed\n");
  const c = await runAdversarialLoop(
    {
      diff: "diff --git a/f b/f\n+x",
      context: "fix",
      workCwd: workRepo,
      fixFence: { callerCwd: callerRepo },
    },
    signal(),
    "job-c",
  );
  const devs = spawnCalls.filter((x) => x.role === "developer");
  assert(devs.length === 1, "C: one fix-developer dispatched");
  assert(
    devs.every((x) => x.cwd === workRepo),
    "C: every fix-developer spawn has cwd === workCwd",
  );
  assert(
    c.ok === true && !c.text.includes("VIOLATION"),
    "C: clean fix round is approved with no violation",
  );

  // ------------------- D. fix developer writes into the caller repo → violation reported
  reset();
  reviewerReplies = [ISSUES, APPROVED];
  process.chdir(callerRepo);
  developerWrite = (cwd) => {
    writeFileSync(path.join(cwd, "f.txt"), "one\nfixed\n");
    writeFileSync(path.join(callerRepo, "stray.txt"), "wrong place\n");
  };
  const d = await runAdversarialLoop(
    {
      diff: "diff --git a/f b/f\n+x",
      context: "viol",
      workCwd: workRepo,
      fixFence: { callerCwd: callerRepo },
    },
    signal(),
    "job-d",
  );
  process.chdir(priorCwd);
  assert(
    d.text.includes("VIOLATION") && d.text.includes("stray.txt"),
    "D: a change to the caller repo during a fix round is reported as a violation",
  );
  assert(
    d.text.includes("attribution not verified"),
    "D: the violation does not claim the fix caused the change",
  );
  assert(
    git(callerRepo, "status", "--porcelain").toString().includes("stray.txt"),
    "D: the stray write really happened (the snapshot saw it)",
  );
  assert(
    ledgerResults.at(-1)?.text.includes("VIOLATION") === true,
    "D: the ledger entry carries the violation text",
  );
  assert(d.ok === false, "D: a breach of the workCwd fence fails the result (ok: false)");

  // -------- E. caller file already dirty; a fix round rewrites its CONTENT only
  // (porcelain status line is unchanged) → still a violation.
  reset();
  git(callerRepo, "clean", "-fdq");
  git(callerRepo, "checkout", "-q", "--", "f.txt");
  writeFileSync(path.join(callerRepo, "f.txt"), "dirty before\n");
  reviewerReplies = [ISSUES, APPROVED];
  process.chdir(callerRepo);
  developerWrite = (cwd) => {
    writeFileSync(path.join(cwd, "f.txt"), "one\nfixed\n");
    writeFileSync(path.join(callerRepo, "f.txt"), "dirty rewritten\n");
  };
  const e = await runAdversarialLoop(
    {
      diff: "diff --git a/f b/f\n+x",
      context: "dirty",
      workCwd: workRepo,
      fixFence: { callerCwd: callerRepo },
    },
    signal(),
    "job-e",
  );
  process.chdir(priorCwd);
  assert(
    git(callerRepo, "status", "--porcelain").toString() === " M f.txt\n",
    "E: the caller file stayed in the same porcelain state",
  );
  assert(
    e.text.includes("VIOLATION") && e.text.includes("f.txt"),
    "E: a content-only rewrite of an already-dirty caller file is reported",
  );
  // -------- F. the first fix dispatch crashes; the infra retry reuses cwd === workCwd
  reset();
  reviewerReplies = [ISSUES, APPROVED];
  devFailures = 1;
  developerWrite = (cwd) => writeFileSync(path.join(cwd, "f.txt"), "one\nretried\n");
  const f = await runAdversarialLoop(
    {
      diff: "diff --git a/f b/f\n+x",
      context: "retry",
      workCwd: workRepo,
      fixFence: { callerCwd: callerRepo },
    },
    signal(),
    "job-f",
  );
  const fdevs = spawnCalls.filter((x) => x.role === "developer");
  assert(fdevs.length === 2, "F: the crashed fix dispatch was retried once");
  assert(
    fdevs.every((x) => x.cwd === workRepo),
    "F: every fix attempt, including the retry, has cwd === workCwd",
  );
  assert(f.ok === true, "F: the round still completes after the retry");

  // -------- G. caller repo's git status is unreadable → reported as not checked, never clean
  reset();
  git(callerRepo, "clean", "-fdq");
  git(callerRepo, "checkout", "-q", "--", "f.txt");
  writeFileSync(path.join(callerRepo, ".git", "index"), "corrupt");
  reviewerReplies = [ISSUES, APPROVED];
  process.chdir(callerRepo);
  developerWrite = (cwd) => writeFileSync(path.join(cwd, "f.txt"), "one\nfixed\n");
  const g = await runAdversarialLoop(
    {
      diff: "diff --git a/f b/f\n+x",
      context: "unreadable",
      workCwd: workRepo,
      fixFence: { callerCwd: callerRepo },
    },
    signal(),
    "job-g",
  );
  process.chdir(priorCwd);
  assert(
    g.text.includes("could not be armed before fix round 1"),
    "G: an unreadable caller snapshot refuses the fix round",
  );
  assert(
    spawnCalls.filter((x) => x.role === "developer").length === 0,
    "G: no fix-developer is dispatched while the fence is unchecked",
  );
  assert(
    g.ok === false && g.loopOutcome === "infra-failure",
    "G: an unchecked fence never approves",
  );

  // -------- H. caller is not a git repository → reported as not checked, never silent
  reset();
  const notRepo = mkdtempSync(path.join(os.tmpdir(), "adv-1104-notrepo-"));
  reviewerReplies = [ISSUES, APPROVED];
  developerWrite = (cwd) => writeFileSync(path.join(cwd, "f.txt"), "one\nfixed\n");
  try {
    const h = await runAdversarialLoop(
      {
        diff: "diff --git a/f b/f\n+x",
        context: "norepo",
        workCwd: workRepo,
        fixFence: { callerCwd: notRepo },
      },
      signal(),
      "job-h",
    );
    assert(
      h.text.includes("fix round 1 caller-repo check did not run (caller is not a git repository)"),
      "H: a non-repo caller is reported as not checked",
    );
  } finally {
    rmSync(notRepo, { recursive: true, force: true });
  }

  // -------- I. a fix dispatch writes to the caller, then THROWS: the violation survives
  reset();
  // G corrupted the caller's index: rebuild it from HEAD before the clean.
  rmSync(path.join(callerRepo, ".git", "index"), { force: true });
  git(callerRepo, "reset", "-q");
  git(callerRepo, "clean", "-fdq");
  git(callerRepo, "checkout", "-q", "--", "f.txt");
  reviewerReplies = [ISSUES, APPROVED];
  devThrow = true;
  developerWrite = (cwd) => {
    writeFileSync(path.join(cwd, "f.txt"), "one\nfixed\n");
    writeFileSync(path.join(callerRepo, "stray.txt"), "wrong place\n");
  };
  const i = await runAdversarialLoop(
    {
      diff: "diff --git a/f b/f\n+x",
      context: "throw",
      workCwd: workRepo,
      fixFence: { callerCwd: callerRepo },
    },
    signal(),
    "job-i",
  );
  assert(i.ok === false, "I: a throwing fix round is not ok");
  assert(i.loopOutcome === "infra-failure", "I: a throwing fix round is infra-failure");
  assert(i.text.includes("threw: spawn exploded"), "I: the result carries the error message");
  assert(
    i.text.includes("VIOLATION") && i.text.includes("stray.txt"),
    "I: the caller write made before the throw is reported in the result",
  );
  assert(
    ledgerResults.length === 1 &&
      ledgerResults[0]?.text.includes("VIOLATION") === true &&
      ledgerResults[0]?.text.includes("threw: spawn exploded") === true,
    "I: the ledger write carries both the violation and the error",
  );
} finally {
  process.chdir(priorCwd);
  rmSync(workBase, { recursive: true, force: true });
  rmSync(callerRepo, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
