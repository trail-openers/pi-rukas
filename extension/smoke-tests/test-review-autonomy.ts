#!/usr/bin/env bun
/**
 * #1154 — review autonomy: a tool-path reportOnly review's verdict feeds the
 * merge guard. The ledger row is the one the REAL writeAdversarialLedgerEntry
 * produced from the REAL runAdversarialLoop result (reportVerdict "terminal"),
 * read back from a temp ledger (PI_ENSEMBLE_REVIEW_LEDGER_FILE). That row is
 * then driven through the real merge guard hook with two lens shapes:
 *
 *   - strict: the lens row is passed:true → merge allowed.
 *   - round-cap (#973): the lens row is ISSUES_FOUND at the cap with no
 *     hasCritical and no residual disclosure marker → refused.
 *
 * #1161 — a review of a caller-pasted diff is written as a non-passing row, so
 * the guard refuses it; the same review via base+head is written as passing.
 * A tool-path CRITICAL_ISSUES_FOUND row must stay refused even with a passing
 * lens. The verdict-to-outcome mapping is asserted in
 * test-adversarial-report-only-parse.ts, not here.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAdversarialLedgerEntry } from "../src/adversarial-ledger.ts";
import { readLedgerAt } from "../src/review-ledger.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import { type NormalisedSpec, parkAction } from "../src/work-driver-intent.ts";
import { installLoopSeams } from "./adversarial-loop-helpers.ts";
import {
  assert,
  TARGET,
  exit,
  hookDecision,
  latestEntry,
  setupLedgerPath,
  teardownLedger,
} from "./merge-guard-helpers.ts";
import type { LedgerEntry } from "./merge-guard-helpers.ts";

let reply = "";
await installLoopSeams(async (spec) => ({
  role: spec.role,
  ok: true,
  text: reply,
  toolUses: [],
  ms: 10,
  exitCode: 0,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
}));

const { runAdversarialLoop } = await import("../src/adversarial.ts");

const DIFF = "diff --git a/x.txt b/x.txt\n+added line\n";
const HEAD = "a".repeat(40);
const TARGET_HEAD = { ...TARGET, headOid: HEAD };
const BRANCH = TARGET.headBranch;
// The loop's own ledger write is a no-op here: its workCwd is not a git repo,
// so the writer traces "no mainline" and writes nothing. The row under test is
// written explicitly below by the real writer, from the same result.
const loopDir = mkdtempSync(path.join(os.tmpdir(), "review-autonomy-loop-"));
// A real clone with a mainline, one committed change (the range the base+head
// review judges) and one uncommitted change (the working tree the pasted-diff
// review's writer reads), so both rows are written by the real writer.
const repoDir = mkdtempSync(path.join(os.tmpdir(), "review-autonomy-"));
const ledgerFile = () => process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE ?? "";

function setupRepo() {
  const g = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "test");
  writeFileSync(path.join(repoDir, "x.txt"), "base\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  g("remote", "add", "origin", repoDir);
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  g("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  writeFileSync(path.join(repoDir, "x.txt"), "base\nadded\n");
  g("add", "-A");
  g("commit", "-q", "-m", "change");
  writeFileSync(path.join(repoDir, "x.txt"), "base\nadded\nuncommitted\n");
}

/**
 * A tool-path reportOnly review, recorded by the REAL ledger writer. The
 * caller-pasted-diff review and the base+head review differ only in how the
 * diff was supplied (the range diff is stubbed; it is not under test here).
 */
async function reviewRow(text: string, callerSuppliedDiff: boolean): Promise<LedgerEntry> {
  reply = text;
  const diffSource = callerSuppliedDiff ? { diff: DIFF } : { base: "origin/main", head: "HEAD" };
  const result = await runAdversarialLoop(
    {
      ...diffSource,
      context: "ctx",
      workCwd: loopDir,
      branch: BRANCH,
      reportOnly: true,
      reportRound: 1,
      reportVerdict: "terminal",
    },
    new AbortController().signal,
    "job-review-autonomy",
    async () => ({ ok: true as const, diff: DIFF }),
  );
  await writeAdversarialLedgerEntry(result, {
    workCwd: repoDir,
    branch: BRANCH,
    callerSuppliedDiff,
  });
  const row = latestEntry(readLedgerAt(ledgerFile()), BRANCH, "adversarial");
  if (!row) throw new Error("the real ledger writer recorded no adversarial row");
  return row;
}

const ISSUES_TEXT = "VERDICT: ISSUES_FOUND\n\n### ISSUES\n- x.txt:1 — the added line lacks a test";

try {
  setupRepo();
  await setupLedgerPath();

  const issues = await reviewRow(ISSUES_TEXT, false);
  const PATCH = issues.patchId;

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

  const strict = await hookDecision("gh pr merge 12", [issues, lensPassedRow], {
    patchId: PATCH,
  });
  assert(strict.block === false, "tool-path ISSUES_FOUND + strict lens passed: merge allowed");

  const capped = await hookDecision("gh pr merge 12", [issues, lensCapped], {
    patchId: PATCH,
    ghComments: RESIDUAL_MARKER,
    fetchedHead: HEAD,
    target: TARGET_HEAD,
  });
  assert(
    capped.block === false,
    "tool-path ISSUES_FOUND + round-capped lens with residual marker: merge allowed",
  );

  const uncapped = await hookDecision("gh pr merge 12", [issues, lensCapped], {
    patchId: PATCH,
    ghComments: JSON.stringify({ comments: [] }),
    fetchedHead: HEAD,
    target: TARGET_HEAD,
  });
  assert(
    uncapped.block === true,
    "tool-path ISSUES_FOUND + round-capped lens without marker: merge refused",
  );

  // #1161 — the same review of a caller-pasted diff is not a passing review.
  const pasted = await reviewRow(ISSUES_TEXT, true);
  assert(pasted.passed === false, "caller-supplied diff: real writer row is passed:false");
  assert(
    pasted.detail?.endsWith(" (caller-supplied diff)") === true,
    "caller-supplied diff: real writer row detail names the caller-supplied diff",
  );
  const pastedRefused = await hookDecision("gh pr merge 12", [pasted, lensPassedRow], {
    patchId: PATCH,
  });
  assert(
    pastedRefused.block === true,
    "caller-supplied diff + strict lens passed: merge refused by the guard",
  );

  const critical = await reviewRow("VERDICT: CRITICAL_ISSUES_FOUND\n\n1. broken", false);
  const refused = await hookDecision("gh pr merge 12", [critical, lensPassedRow], {
    patchId: PATCH,
  });
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
  for (const dir of [repoDir, loopDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
  teardownLedger();
}

console.log(`\nexit ${exit}`);
process.exit(exit);
