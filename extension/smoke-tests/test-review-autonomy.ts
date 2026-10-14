#!/usr/bin/env bun
/**
 * #1154 — review autonomy: a tool-path reportOnly review's verdict feeds the
 * merge guard. The verdict comes from the REAL runAdversarialLoop tool-path
 * result (reportVerdict "terminal"); the test converts it to a ledger row itself
 * (passed = adversarialPassed(result), fixed patchId). The ledger writer is NOT
 * exercised here, so the row shape is the test's, not the writer's. That row is
 * then driven through the real merge guard hook with two lens shapes:
 *
 *   - strict: the lens row is passed:true → merge allowed.
 *   - round-cap (#973): the lens row is ISSUES_FOUND at the cap with no
 *     hasCritical and no residual disclosure marker → refused (the marker is
 *     what makes the non-blocking findings visible; without it, no merge).
 *
 * A tool-path CRITICAL_ISSUES_FOUND row must stay refused even with a passing
 * lens. The tool-path verdict cases (approved / rejected / infra-failure) are covered
 * in test-adversarial-report-only-parse.ts and test-adversarial-tool-guards.ts.
 */

import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { adversarialPassed } from "../src/review-ledger.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import { type NormalisedSpec, parkAction } from "../src/work-driver-intent.ts";
import {
  assert,
  TARGET,
  exit,
  hookDecision,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";
import type { LedgerEntry } from "./merge-guard-helpers.ts";

type SpawnSpec = { role: string; prompt: string; cwd?: string };
let reply = "";
mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-review-autonomy",
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

const repoDir = mkdtempSync(path.join(os.tmpdir(), "review-autonomy-"));
const DIFF = "diff --git a/x.txt b/x.txt\n+added line\n";
const PATCH = "p1";
const HEAD = "a".repeat(40);
const TARGET_HEAD = { ...TARGET, headOid: HEAD };
const BRANCH = TARGET.headBranch;

/**
 * Runs a tool-path reportOnly review and returns the ledger row built from its
 * verdict. The row is hand-built here, not read back from the ledger writer.
 */
async function toolRow(text: string): Promise<LedgerEntry> {
  reply = text;
  const result = await runAdversarialLoop(
    {
      diff: DIFF,
      context: "ctx",
      workCwd: repoDir,
      branch: BRANCH,
      reportOnly: true,
      reportRound: 1,
      reportVerdict: "terminal",
    },
    new AbortController().signal,
    "job-review-autonomy",
  );
  return {
    branch: BRANCH,
    kind: "adversarial",
    patchId: PATCH,
    passed: adversarialPassed(result),
    at: 1,
  };
}

const lensPassedRow: LedgerEntry = {
  branch: BRANCH,
  kind: "lens",
  patchId: PATCH,
  passed: true,
  detail: "APPROVED",
  hasCritical: false,
  round: 1,
  at: 2,
};
const lensCapped: LedgerEntry = {
  branch: BRANCH,
  kind: "lens",
  patchId: PATCH,
  passed: false,
  detail: "ISSUES_FOUND",
  hasCritical: false,
  round: 3,
  headSha: HEAD,
  at: 2,
};
const RESIDUAL_MARKER = JSON.stringify({
  comments: [
    { body: `residuals\n<!-- pi-rukas:lens-residuals branch=${BRANCH} patch=${PATCH} -->` },
  ],
});

try {
  execFileSync("git", ["-C", repoDir, "init", "-q", "-b", "main"], { stdio: "pipe" });
  await setupLedgerPath();

  const issues = await toolRow(
    "VERDICT: ISSUES_FOUND\n\n### ISSUES\n- x.txt:1 — the added line lacks a test",
  );
  assert(issues.passed === true, "tool-path ISSUES_FOUND: adversarial row is passed:true");

  const strict = await hookDecision("gh pr merge 12", [issues, lensPassedRow]);
  assert(strict.block === false, "tool-path ISSUES_FOUND + strict lens passed: merge allowed");

  const capped = await hookDecision("gh pr merge 12", [issues, lensCapped], {
    ghComments: RESIDUAL_MARKER,
    fetchedHead: HEAD,
    target: TARGET_HEAD,
  });
  assert(
    capped.block === false,
    "tool-path ISSUES_FOUND + round-capped lens with residual marker: merge allowed",
  );

  const uncapped = await hookDecision("gh pr merge 12", [issues, lensCapped], {
    ghComments: JSON.stringify({ comments: [] }),
    fetchedHead: HEAD,
    target: TARGET_HEAD,
  });
  assert(
    uncapped.block === true,
    "tool-path ISSUES_FOUND + round-capped lens without marker: merge refused",
  );

  const critical = await toolRow("VERDICT: CRITICAL_ISSUES_FOUND\n\n1. broken");
  assert(
    critical.passed === false,
    "tool-path CRITICAL_ISSUES_FOUND: adversarial row is passed:false",
  );
  const refused = await hookDecision("gh pr merge 12", [critical, lensPassedRow]);
  assert(
    refused.block === true,
    "tool-path CRITICAL_ISSUES_FOUND + strict lens passed: merge refused",
  );
  // #1151 — intent-gate autonomy. A non-security CRITICAL open point must not
  // stall a buildable issue; a security one parks with its own reason; and the
  // answer (marked [RESOLVED] in the body, then --restart) clears the park.
  const buildable: NormalisedSpec = {
    intent: "Keep the retry timeout configurable.",
    deliverables: [
      {
        id: "d1",
        description: "make the timeout configurable",
        paths: ["extension/src/retry-config-check.ts"],
      },
    ],
    acceptanceCriteria: ["the timeout is read from config"],
    outOfScope: [],
    assumptions: [],
    openQuestions: [],
    evidence: [
      {
        claim: "the timeout is hard-coded",
        source: "retry-config-check.ts:1",
        verdict: "confirmed",
      },
    ],
    verdict: "proceed",
    rationale: "actionable",
  };
  const body = (point: string) => `## Open points (unresolved at the gap-gate cap)\n\n- ${point}\n`;

  const nonSecurity = finaliseSpecVerdict(
    buildable,
    body("[CRITICAL] Which timeout wins when both are set \u2014 proposed: the shorter"),
  );
  assert(
    nonSecurity.verdict === "proceed-with-assumptions",
    "autonomy: a non-security CRITICAL open point still proceeds to the PR path",
  );

  const security = finaliseSpecVerdict(
    buildable,
    body("[CRITICAL] Who may change the retry timeout \u2014 authorization is undecided"),
  );
  assert(
    security.verdict === "park" && security.parkReason === "security-open-point",
    "autonomy: a security CRITICAL open point parks with security-open-point",
  );
  assert(
    /--restart/.test(parkAction("security-open-point", 42)),
    "autonomy: the security park names the answer-and-restart way out",
  );

  const answered = finaliseSpecVerdict(
    buildable,
    body("[CRITICAL][RESOLVED] Who may change the retry timeout \u2014 maintainers only"),
  );
  assert(
    answered.verdict !== "park",
    "autonomy: the same point marked [RESOLVED] does not park after --restart",
  );
  const spacedResolved = finaliseSpecVerdict(
    buildable,
    body("[CRITICAL] [RESOLVED] Who may change the retry timeout \u2014 maintainers only"),
  );
  assert(
    spacedResolved.verdict === "proceed" &&
      spacedResolved.assumptions.some((a) => /Resolved open point/.test(a.text)),
    "autonomy: [CRITICAL] [RESOLVED] (spaced) is resolved and recorded as an assumption",
  );
  // Strikethrough is no longer a resolution convention: the line is unparsed and caps the proceed.
  const struck = finaliseSpecVerdict(
    buildable,
    body("~~[CRITICAL] Who may change the retry timeout~~ \u2014 answered: maintainers"),
  );
  assert(
    struck.verdict === "proceed-with-assumptions" &&
      struck.assumptions.some((a) => /could not parse a CRITICAL line/.test(a.text)),
    "autonomy: a struck-through point is not resolved; it caps the proceed as unparsed",
  );
  // [RESOLVED] must sit right after the tag; anywhere else the point still gates.
  const trailing = finaliseSpecVerdict(
    buildable,
    body("[CRITICAL] Who may change the retry timeout \u2014 maintainers only [RESOLVED]"),
  );
  assert(
    trailing.assumptions.some((a) => /unresolved CRITICAL open point/.test(a.text)),
    "autonomy: [RESOLVED] after the point text does not resolve it",
  );
} finally {
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {}
  teardownLedger();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
