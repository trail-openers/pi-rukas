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
 *     hasCritical and no residual disclosure marker → refused (the marker is
 *     what makes the non-blocking findings visible; without it, no merge).
 *
 * A tool-path CRITICAL_ISSUES_FOUND row must stay refused even with a passing
 * lens. The tool-path verdict cases (approved / rejected / infra-failure) are covered
 * in test-adversarial-report-only-parse.ts and test-adversarial-tool-guards.ts.
 * #1161 — a caller-pasted diff is written as a non-passing row, so the guard
 * refuses it; the verdict-to-outcome mapping is asserted only in
 * test-adversarial-report-only-parse.ts, not here.
 */

import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeAdversarialLedgerEntry } from "../src/adversarial-ledger.ts";
import { latestEntry, readLedgerAt } from "../src/review-ledger.ts";
import { finaliseSpecVerdict } from "../src/work-driver-intent-finalise.ts";
import { type NormalisedSpec, parkAction } from "../src/work-driver-intent.ts";
import {
  buildPrRepo,
  mergeWithoutDisclosure,
  roundCapDecision,
  seedFindings,
  storeFileOf,
  waitForLensRound,
  withBundledSkillsDir,
} from "./lib/review-autonomy-fixtures.ts";
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
const { runLensReview } = await import("../src/lens-review.ts");

const DIFF = "diff --git a/x.txt b/x.txt\n+added line\n";
const HEAD = "a".repeat(40);
const TARGET_HEAD = { ...TARGET, headOid: HEAD };
const BRANCH = TARGET.headBranch;
// The loop's own ledger write is a no-op here: its workCwd is not a git repo,
// so the writer traces "no mainline" and writes nothing. The row under test is
// written explicitly below by the real writer, from the same result.
const loopDir = mkdtempSync(path.join(os.tmpdir(), "review-autonomy-loop-"));
// A real clone with a mainline and one uncommitted change, so the real writer
// computes a working-tree patch id the way it does in production.
const repoDir = mkdtempSync(path.join(os.tmpdir(), "review-autonomy-"));
const ledgerFile = () => process.env.PI_ENSEMBLE_REVIEW_LEDGER_FILE ?? "";

function setupRepo() {
  const g = (...args: string[]) => execFileSync("git", ["-C", repoDir, ...args], { stdio: "pipe" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "test");
  writeFileSync(path.join(repoDir, "x.txt"), "base\n");
  writeFileSync(path.join(repoDir, "y.txt"), "a\nb\nc\nd\n");
  g("add", "-A");
  g("commit", "-q", "-m", "base");
  g("remote", "add", "origin", repoDir);
  g("update-ref", "refs/remotes/origin/main", "HEAD");
  g("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  writeFileSync(path.join(repoDir, "x.txt"), "base\nadded\n");
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

// ── #1125/#1144 — what a finding OUTSIDE the PR's changed lines may do ──────
//
// The three scenarios run the REAL review (`runLensReview`, lens children
// injected) over a real clone, and the REAL merge guard on the ledger row that
// review wrote. Their findings arrive through the findings store's carried list
// — the path a finding takes in round 2+. The scaffolding (seeding that store,
// reading the ledger row, driving the guard) lives in
// smoke-tests/lib/review-autonomy-fixtures.ts. The clone is built so the
// changed ranges are known exactly: the PR's last commit appends ONE line to
// x.txt, so line 4 is the only changed line, and no line of y.txt (present on
// both sides of the range) is. Every review advances the branch's round
// counter, so the scenarios read rounds 1, 2 and 3 of one branch.

/** The line the PR changes, and a file the PR never touches. */
const CHANGED_LINE = 4;
const UNTOUCHED_FILE = "y.txt";

const noFindings = async (args: { lens: { name: string } }) =>
  ({
    lens: args.lens.name,
    ok: true,
    ms: 1,
    startMs: Date.now(),
    attempts: 1,
    blocked: false,
    summary: "reviewed the diff",
    findings: [],
  }) as never;

/** #1144 — the three autonomy scenarios: an out-of-range carried finding is
 * advisory and merges; an in-diff MEDIUM blocks (the control); an out-of-diff
 * CRITICAL does not set hasCritical. */
async function autonomyScenarios() {
  // #1144 fix round 1 — the scenarios run the REAL `runLensReview`, so they
  // need the REAL lens roster: without a pinned skills dir a CI runner's empty
  // `~/.pi/agent/skills` marks every lens blocked and the verdict is
  // REVIEW_INCOMPLETE before the injected child is consulted. Pinned for the
  // lifetime of the rounds and restored afterwards.
  await withBundledSkillsDir(async () => {
    buildPrRepo(
      repoDir,
      TARGET.headBranch,
      { "x.txt": "first\nsecond\nthird\n", [UNTOUCHED_FILE]: "a\nb\nc\nd\n" },
      { "x.txt": "first\nsecond\nthird\nadded\n" },
    );
    const round = () =>
      runLensReview({
        cwd: repoDir,
        branch: TARGET.headBranch,
        head: TARGET.headBranch,
        base: "origin/main",
        // The range is tool-computed (`git diff origin/main...feature/x`) — the
        // read the advisory split makes; a pasted string would not test it.
        lensChildFn: noFindings as never,
        // Whole-branch each time: the automatic delta base (#973) would narrow
        // rounds 2+ to a fix commit these scenarios never make.
        full: true,
      });
    const seed = (rows: Parameters<typeof seedFindings>[2]) =>
      seedFindings(storeFileOf(ledgerFile()), TARGET.headBranch, rows);
    const lensRow = (n: number) => waitForLensRound(ledgerFile(), TARGET.headBranch, n);
    const capped = (row: LedgerEntry | undefined, over?: Partial<LedgerEntry>) => {
      if (!row) throw new Error("the review recorded no lens entry");
      return roundCapDecision({ row, target: TARGET, over });
    };
    // Every lens ran. A blocked roster row makes the verdict REVIEW_INCOMPLETE
    // for a reason that has nothing to do with the split under test, so each
    // scenario asserts the fan-out was healthy before it asserts anything about
    // what the findings did.
    const allRan = (out: { lenses: { blocked?: boolean }[] }, label: string) =>
      assert(
        out.lenses.length > 0 && out.lenses.every((l) => !l.blocked),
        `${label}: every lens ran (no blocked roster row)`,
      );

    // (a) A carried CRITICAL on a file the PR does not change: ADVISORY. It
    // neither decides the verdict nor sets `hasCritical` — the #1143 invariant the
    // round-cap rule and the merge guard both read — and the round-capped merge it
    // leaves behind is allowed: disclosed, not blocking.
    seed([{ severity: "CRITICAL", path: UNTOUCHED_FILE, line: 3, title: "out-of-diff critical" }]);
    const out = await round();
    const outRow = await lensRow(1);
    allRan(out, "#1144 (a)");
    assert(
      out.verdict === "APPROVED" && out.findings.length === 0,
      `#1144: a carried out-of-diff CRITICAL does not block (got ${out.verdict})`,
    );
    assert(
      out.advisory?.length === 1 && out.advisory[0]?.path === UNTOUCHED_FILE,
      "#1144: the out-of-diff CRITICAL is listed as advisory",
    );
    assert(
      outRow?.hasCritical === false,
      "#1144: an out-of-diff CRITICAL does not set hasCritical",
    );
    const allowed = await capped(outRow);
    assert(
      allowed.block === false,
      `#1144: a carried out-of-range finding is advisory and merge is allowed (${allowed.reason ?? ""})`,
    );

    // (b) The control: the same MEDIUM, unchanged and still reported, ON the line
    // the PR changed. It blocks.
    seed([{ severity: "MEDIUM", path: "x.txt", line: CHANGED_LINE, title: "in-diff medium" }]);
    const inDiff = await round();
    const inRow = await lensRow(2);
    allRan(inDiff, "#1144 (b)");
    assert(
      inDiff.verdict === "ISSUES_FOUND" && inDiff.findings.length === 1,
      `#1144: an unchanged, still-reported in-diff MEDIUM still blocks (got ${inDiff.verdict})`,
    );
    assert(!inDiff.advisory, "#1144: the in-diff MEDIUM is not advisory");
    assert(inRow?.detail === "ISSUES_FOUND", "#1144: the in-diff MEDIUM records a blocking entry");
    // Forced onto the round-cap path (the strict rule's `passed` normally refuses
    // an ISSUES_FOUND entry), the finding is carried WITH its disclosure — and
    // without the disclosure the guard refuses. Advisory never means invisible.
    if (!inRow) throw new Error("the review recorded no lens entry");
    const carried = await capped(inRow, { passed: false });
    const undisclosed = await mergeWithoutDisclosure({ row: inRow, target: TARGET });
    assert(
      carried.block === false,
      `#1144: the control — an in-diff MEDIUM blocks the verdict and is carried with disclosure (${carried.reason ?? ""})`,
    );
    assert(
      undisclosed.block === true,
      "#1144: with no disclosure on the PR the round-capped merge is refused",
    );

    // (c) A CRITICAL ON the changed line: the store carries it (a CRITICAL is
    // never resolved by a no-re-report), so #1125's split is the only thing that
    // could have made it advisory. It did not — the line is in the range, so the
    // finding blocks and sets `hasCritical`.
    seed([{ severity: "CRITICAL", path: "x.txt", line: CHANGED_LINE, title: "in-diff critical" }]);
    const crit = await round();
    const critRow = await lensRow(3);
    allRan(crit, "#1144 (c)");
    assert(
      crit.verdict === "CRITICAL_ISSUES_FOUND" && critRow?.hasCritical === true,
      `#1144: a CRITICAL on a changed line blocks and sets hasCritical (got ${crit.verdict})`,
    );
  });
}

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

  // #1151 — intent-gate autonomy. A buildable issue parks on any unresolved CRITICAL
  // open point (#1187), and a [RESOLVED] answer plus --restart clears the park.

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

  // #1187 — topic-neutral: every unresolved CRITICAL point parks, whatever its topic.
  const retry = finaliseSpecVerdict(
    buildable,
    body("[CRITICAL] Which timeout wins when both are set \u2014 proposed: the shorter"),
  );
  assert(
    retry.verdict === "park" && retry.parkReason === "unresolved-critical-open-point",
    "autonomy: a topic-neutral CRITICAL open point (a retry timeout) parks",
  );
  assert(
    /--restart/.test(parkAction("unresolved-critical-open-point", 42)) &&
      /\[RESOLVED\]/.test(parkAction("unresolved-critical-open-point", 42)),
    "autonomy: the park names the [RESOLVED] answer and the --restart way out",
  );
  const authz = finaliseSpecVerdict(
    buildable,
    body("[CRITICAL] Who may change the retry timeout \u2014 authorization is undecided"),
  );
  assert(
    authz.verdict === "park" && authz.openPoints?.length === 1,
    "autonomy: a CRITICAL point the old classifier named parks the same way, and is recorded",
  );

  const answered = finaliseSpecVerdict(
    buildable,
    body("[CRITICAL][RESOLVED] Who may change the retry timeout \u2014 maintainers only"),
  );
  assert(
    answered.verdict === "proceed" &&
      answered.assumptions.some(
        (a) =>
          a.text ===
          "resolved open point: [CRITICAL][RESOLVED] Who may change the retry timeout \u2014 maintainers only",
      ),
    "autonomy: the same point marked [RESOLVED] proceeds, recorded as a prefixed assumption",
  );
  const spacedResolved = finaliseSpecVerdict(
    buildable,
    body("[CRITICAL] [RESOLVED] Who may change the retry timeout \u2014 maintainers only"),
  );
  assert(
    spacedResolved.verdict === "proceed" &&
      spacedResolved.assumptions.some((a) => /Who may change/.test(a.text)),
    "autonomy: [CRITICAL] [RESOLVED] (spaced) is resolved and recorded as an assumption",
  );
  // A blank body is its own park, and a complete spec cannot lift it (#1187).
  const blank = finaliseSpecVerdict(buildable, "  \n");
  assert(
    blank.verdict === "park" && blank.parkReason === "blank-issue-body",
    "autonomy: a blank issue body parks as blank-issue-body, not lifted by a complete spec",
  );
  // Strikethrough: a struck severity tag is not a readable tag, so the point parks.
  const struck = finaliseSpecVerdict(
    buildable,
    body("~~[CRITICAL] Who may change the retry timeout~~ \u2014 answered: maintainers"),
  );
  assert(
    struck.verdict === "park" && struck.openPoints?.length === 1,
    "autonomy: a struck-through severity point parks",
  );
  // [RESOLVED] must sit right after the tag; anywhere else the point still gates.
  const trailing = finaliseSpecVerdict(
    buildable,
    body("[CRITICAL] Who may change the retry timeout \u2014 maintainers only [RESOLVED]"),
  );
  assert(
    trailing.verdict === "park" &&
      trailing.openPoints?.some((p) => p.endsWith("[RESOLVED]")) === true,
    "autonomy: [RESOLVED] after the point text does not resolve it",
  );
  // #1125/#1144 — what a finding outside the PR's changed lines may do to a
  // merge (the three autonomy scenarios, last so they see the rounds they name).
  await autonomyScenarios();
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
