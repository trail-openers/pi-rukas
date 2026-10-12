#!/usr/bin/env bun
/**
 * Hotfix regression — a well-formed reviewer verdict must NOT be reported as
 * "produced no readable VERDICT marker" on the reportOnly path (#1114 / #1123).
 *
 * `parseVerdict` returned `{status, findings, raw}` on a successful match and
 * never set `verdictParsed`; the reportOnly guard treated `undefined` as
 * unparsed, so every real reviewer reply became an infra failure. The driver
 * tests missed it because their mocks hand-set `verdictParsed: true`.
 *
 * This test deliberately sets NO verdictParsed anywhere. It drives the real
 * `runAdversarialLoop` with `reportOnly` and a stub reviewer dispatcher whose
 * replies are reviewer-shaped text, then asserts on the parsed result.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
let reply = "";
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-report-only-parse",
  spawnSpecialist: async (spec: SpawnSpec) => ({
    role: spec.role,
    ok: true,
    text: reply,
    toolUses: [],
    ms: 10,
    exitCode: 0,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
  }),
}));
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
const { parseVerdict } = await import("../src/adversarial-verdict.ts");

// A scratch repo keeps the review-ledger write off the real clone.
const repoDir = mkdtempSync(path.join(os.tmpdir(), "adv-report-only-parse-"));
const DIFF = "diff --git a/x.txt b/x.txt\n+added line\n";

async function reportOnce(text: string) {
  reply = text;
  return runAdversarialLoop(
    {
      diff: DIFF,
      context: "ctx",
      workCwd: repoDir,
      branch: "fix/report-only-parse",
      reportOnly: true,
      reportRound: 1,
    },
    new AbortController().signal,
    "job-report-only-parse",
  );
}

try {
  execFileSync("git", ["-C", repoDir, "init", "-q", "-b", "main"], { stdio: "pipe" });

  // The parser on its own: a successful match is parsed, explicitly.
  assert(
    parseVerdict("VERDICT: APPROVED").verdictParsed === true,
    "parseVerdict: a marker-bearing reply reports verdictParsed === true",
  );
  assert(
    parseVerdict("nothing here").verdictParsed === false,
    "parseVerdict: a reply without a marker reports verdictParsed === false",
  );

  // 1. Reviewer-shaped ISSUES_FOUND, marker first, findings after.
  const issues = await reportOnce(
    "VERDICT: ISSUES_FOUND\n\n### ISSUES\n- x.txt:1 — the added line lacks a test",
  );
  const r1 = issues.adversarialRounds?.[0];
  assert(
    r1?.verdictParsed === true && r1.status === "ISSUES_FOUND",
    "ISSUES_FOUND reply: parsed round record with status ISSUES_FOUND",
  );
  assert(
    !issues.text.includes("produced no readable VERDICT marker"),
    "ISSUES_FOUND reply: not reported as unreadable",
  );
  assert(issues.loopOutcome === "rejected", "ISSUES_FOUND reply: loopOutcome rejected (not infra)");

  // 2. Reviewer with a short preamble before the marker line.
  const preamble = await reportOnce(
    "I reviewed the diff against the issue and the lenses.\n\nVERDICT: ISSUES_FOUND\n\n- x.txt:1 — missing test",
  );
  const r2 = preamble.adversarialRounds?.[0];
  assert(
    r2?.verdictParsed === true && r2.status === "ISSUES_FOUND",
    "preamble + ISSUES_FOUND: parsed round record with status ISSUES_FOUND",
  );
  assert(
    !preamble.text.includes("produced no readable VERDICT marker"),
    "preamble + ISSUES_FOUND: not reported as unreadable",
  );

  // 3. Clean approval.
  const approved = await reportOnce("VERDICT: APPROVED\n\nNo issues found.");
  const r3 = approved.adversarialRounds?.[0];
  assert(
    r3?.verdictParsed === true && r3.status === "APPROVED",
    "APPROVED reply: parsed round record with status APPROVED",
  );
  assert(approved.loopOutcome === "approved", "APPROVED reply: loopOutcome approved");

  // 4. No VERDICT anywhere → infrastructure failure, never a verdict.
  const none = await reportOnce("I looked at the diff and have thoughts but no marker.");
  assert(
    none.text.includes("produced no readable VERDICT marker"),
    "reply without a VERDICT marker: reported as unreadable (infra)",
  );
  assert(none.loopOutcome !== "approved", "reply without a VERDICT marker: never approved");
} finally {
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {}
}

console.log(`\nexit ${exit}`);
process.exit(exit);
