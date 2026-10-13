#!/usr/bin/env bun
/**
 * #1154 — a reportOnly review through the adversarial_loop TOOL is the loop's
 * only round, so it is judged by the terminal-round rule: ISSUES_FOUND and
 * MINOR_OBSERVATIONS pass (recorded passed, loopOutcome approved, findings kept
 * in the text as residuals), CRITICAL_ISSUES_FOUND rejects, an unreadable
 * verdict is an infrastructure failure. The /work driver's reportOnly path
 * (no `reportOnlyTerminal`) keeps its non-terminal routing and is asserted
 * here too as the regression guard.
 *
 * The final section drives the merge guard with the adversarial row this
 * result produces plus the #973 round-cap lens conditions, and expects
 * "merge allowed".
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mock } from "bun:test";
import { adversarialPassed } from "../src/review-ledger.ts";
import {
  assert,
  exit,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
  TARGET,
} from "./merge-guard-helpers.ts";
import type { LedgerEntry } from "./merge-guard-helpers.ts";

type SpawnSpec = { role: string; prompt: string; cwd?: string };
let reply = "";
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-report-only-terminal",
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

// A scratch repo keeps the review-ledger write off the real clone.
const repoDir = mkdtempSync(path.join(os.tmpdir(), "adv-report-only-terminal-"));
const DIFF = "diff --git a/x.txt b/x.txt\n+added line\n";

async function review(text: string, terminal: boolean) {
  reply = text;
  return runAdversarialLoop(
    {
      diff: DIFF,
      context: "ctx",
      workCwd: repoDir,
      branch: "fix/report-only-terminal",
      reportOnly: true,
      reportRound: 1,
      ...(terminal ? { reportOnlyTerminal: true } : {}),
    },
    new AbortController().signal,
    "job-report-only-terminal",
  );
}

const ISSUES = "VERDICT: ISSUES_FOUND\n\n### ISSUES\n- x.txt:1 — the added line lacks a test";
const FINDINGS_SENTENCE = "the added line lacks a test";

try {
  execFileSync("git", ["-C", repoDir, "init", "-q", "-b", "main"], { stdio: "pipe" });

  // Tool path: ISSUES_FOUND is the terminal verdict and passes (non-blocking).
  const issues = await review(ISSUES, true);
  assert(issues.loopOutcome === "approved", "tool path ISSUES_FOUND: loopOutcome approved");
  assert(adversarialPassed(issues) === true, "tool path ISSUES_FOUND: ledger passed === true");
  assert(
    issues.text.includes(FINDINGS_SENTENCE),
    "tool path ISSUES_FOUND: findings stay in the result text as residuals",
  );

  // MINOR_OBSERVATIONS passes on both paths.
  const minor = await review("VERDICT: MINOR_OBSERVATIONS\n\nnit", true);
  assert(adversarialPassed(minor) === true, "tool path MINOR_OBSERVATIONS: passed");

  // CRITICAL rejects.
  const critical = await review("VERDICT: CRITICAL_ISSUES_FOUND\n\n- broken", true);
  assert(critical.loopOutcome === "rejected", "tool path CRITICAL: loopOutcome rejected");
  assert(adversarialPassed(critical) === false, "tool path CRITICAL: not passed");

  // Unreadable verdict is infrastructure, never a pass.
  const unparsed = await review("I reviewed it but wrote no marker.", true);
  assert(
    unparsed.text.includes("produced no readable VERDICT marker"),
    "tool path unparsed: reported as unreadable (infra)",
  );
  assert(adversarialPassed(unparsed) === false, "tool path unparsed: not passed");

  // Driver path (reportOnlyTerminal unset): non-terminal routing is unchanged.
  const driverIssues = await review(ISSUES, false);
  assert(driverIssues.loopOutcome === "rejected", "driver path ISSUES_FOUND: still rejected (fix round)");
  assert(adversarialPassed(driverIssues) === false, "driver path ISSUES_FOUND: not passed");
  const driverApproved = await review("VERDICT: APPROVED\n\nok", false);
  assert(driverApproved.loopOutcome === "approved", "driver path APPROVED: approved");

  // Merge guard: the adversarial row this tool-path result writes, plus the
  // #973 round-cap lens conditions (latest lens ISSUES_FOUND, no CRITICAL,
  // round at the cap, residual marker for the current patch) → merge allowed.
  await setupLedgerPath();
  const PR_HEAD = "a".repeat(40);
  const target = { ...TARGET, headOid: PR_HEAD };
  const adv: LedgerEntry = {
    branch: TARGET.headBranch,
    kind: "adversarial",
    patchId: "p1",
    passed: adversarialPassed(issues),
    at: 1,
  };
  const lens: LedgerEntry = {
    branch: TARGET.headBranch,
    kind: "lens",
    patchId: "p1",
    passed: false,
    detail: "ISSUES_FOUND",
    hasCritical: false,
    round: 3,
    headSha: PR_HEAD,
    at: 2,
  };
  const marker = JSON.stringify({
    comments: [
      {
        body: `residuals\n<!-- pi-rukas:lens-residuals branch=${TARGET.headBranch} patch=p1 -->`,
      },
    ],
  });
  const decision = await hookDecision("gh pr merge 12", [adv, lens], {
    fetchedHead: PR_HEAD,
    target,
    patchId: "p1",
    ghComments: marker,
  });
  assert(decision.block === false, "merge guard: tool-path ISSUES_FOUND + round-capped lens → merge allowed");
} finally {
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {}
  teardownLedger();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
