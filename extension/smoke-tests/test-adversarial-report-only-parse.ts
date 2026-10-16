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

import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AdversarialVerdict } from "../src/adversarial-verdict.ts";
import { adversarialPassed } from "../src/review-ledger.ts";

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

// Parse seam: a reply prefixed `LEGACY-SHAPE` comes back WITHOUT `verdictParsed`,
// the way a verdict object built before the field existed would. Absence must
// fail closed on the reportOnly path, not read as a parsed verdict.
const realVerdict = { ...(await import("../src/adversarial-verdict.ts")) };
const realParseVerdict = realVerdict.parseVerdict;
mock.module(new URL("../src/adversarial-verdict.ts", import.meta.url).href, () => ({
  ...realVerdict,
  parseVerdict: (text: string): AdversarialVerdict => {
    const v = realParseVerdict(text);
    if (!text.startsWith("LEGACY-SHAPE")) return v;
    const { verdictParsed: _absent, ...legacy } = v;
    return legacy as AdversarialVerdict;
  },
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
      reportVerdict: "routed",
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

  // 5. A verdict object with NO verdictParsed field reaching the guard is
  // unreadable (absence = unparsed), never an approval.
  const absent = await reportOnce("LEGACY-SHAPE\nVERDICT: APPROVED\n\nNo issues found.");
  assert(
    absent.text.includes("produced no readable VERDICT marker"),
    "verdict without verdictParsed field: reported as unreadable (infra)",
  );
  assert(absent.loopOutcome !== "approved", "verdict without verdictParsed field: never approved");

  // 6. Tool path (#1154): reportVerdict "terminal" makes the single review the terminal
  // round, so the same parsed verdicts resolve by the terminal-round rule.
  const reportTool = (text: string) => {
    reply = text;
    return runAdversarialLoop(
      {
        diff: DIFF,
        context: "ctx",
        workCwd: repoDir,
        branch: "fix/report-only-parse-tool",
        reportOnly: true,
        reportRound: 1,
        reportVerdict: "terminal",
      },
      new AbortController().signal,
      "job-report-only-parse-tool",
    );
  };
  const toolIssues = await reportTool("VERDICT: ISSUES_FOUND\n\n- x.txt:1 — missing test");
  assert(
    toolIssues.adversarialRounds?.[0]?.verdictParsed === true,
    "tool path ISSUES_FOUND: verdict parsed",
  );
  assert(
    toolIssues.loopOutcome === "approved",
    "tool path ISSUES_FOUND: approved (terminal round)",
  );
  const toolMinor = await reportTool("VERDICT: MINOR_OBSERVATIONS\n\nnit");
  assert(toolMinor.loopOutcome === "approved", "tool path MINOR_OBSERVATIONS: approved");
  const toolCritical = await reportTool("VERDICT: CRITICAL_ISSUES_FOUND\n\n1. broken");
  assert(toolCritical.loopOutcome === "rejected", "tool path CRITICAL_ISSUES_FOUND: rejected");
  const toolUnparsed = await reportTool("no marker here");
  assert(
    toolUnparsed.loopOutcome === "infra-failure",
    "tool path unparsed reply: infra-failure, not a verdict",
  );

  // 6b. The driver's routed reportOnly review (#1154 r2): the same ISSUES_FOUND
  // reply is a per-round verdict, so it routes to a fix pass and is not passed.
  reply = "VERDICT: ISSUES_FOUND\n\n- x.txt:1 — missing test";
  const toolRouted = await runAdversarialLoop(
    {
      diff: DIFF,
      context: "ctx",
      workCwd: repoDir,
      branch: "fix/report-only-parse-routed",
      reportOnly: true,
      reportRound: 1,
      reportVerdict: "routed",
    },
    new AbortController().signal,
    "job-report-only-parse-routed",
  );
  assert(
    toolRouted.loopOutcome === "rejected" && adversarialPassed(toolRouted) === false,
    "reportOnly routed ISSUES_FOUND: rejected and not passed (per-round routing)",
  );

  // 7. #1154 coupling: the terminal rule applies only WITH reportOnly. A
  // non-reportOnly loop (the tool's fix-capable path) whose round 1 is
  // ISSUES_FOUND must NOT record that round as passed: it routes to a fix round
  // and only a later round can approve. Here every round repeats ISSUES_FOUND,
  // so the loop runs all 3 rounds and rejects.
  // (#1161: it carries no verdict policy, so reportVerdict is not passed here)
  reply = "VERDICT: ISSUES_FOUND\n\n- x.txt:1 — missing test";
  const nonReportOnly = await runAdversarialLoop(
    {
      diff: DIFF,
      context: "ctx",
      workCwd: repoDir,
      branch: "fix/report-only-parse-nonterminal",
    },
    new AbortController().signal,
    "job-report-only-parse-nonterminal",
  );
  assert(
    nonReportOnly.adversarialRounds?.length === 3,
    "non-reportOnly loop: ISSUES_FOUND round 1 routes to a fix round (3 rounds run)",
  );
  assert(
    nonReportOnly.text.includes("PASSED WITH FINDINGS after round 3") &&
      !nonReportOnly.text.includes("after round 1"),
    "non-reportOnly loop: round 1 ISSUES_FOUND is not passed (only the final round passes it)",
  );
} finally {
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {}
}

console.log(`\nexit ${exit}`);
process.exit(exit);
