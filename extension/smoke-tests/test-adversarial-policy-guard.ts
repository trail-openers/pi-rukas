#!/usr/bin/env bun
/**
 * #1161 — the reportOnly verdict-policy guard, and the adversarial_loop tool
 * boundary's caller-supplied-diff flag.
 *
 *   - K: a reportOnly review with no recognised verdict policy — an absent
 *     `reportVerdict` or an unrecognised value (the untyped JS caller) — is an
 *     infra-failure naming the policy. It dispatches nothing and is never
 *     judged as a routed round.
 *   - M: a reportOnly that is not a boolean, or a reportVerdict without
 *     reportOnly (untyped callers), is an infra-failure naming the reason.
 *   - L: a diff pasted into the tool is recorded as caller-supplied; the same
 *     review via base+head is not. The tool sets the flag after the raw
 *     arguments, so a raw argument cannot clear it.
 *
 * Drives the REAL runAdversarialLoop and registerAdversarialTool over a real
 * git worktree. The spawn, ledger-writer, async-jobs, deck and registry seams
 * are mocked (same seams as test-adversarial-tool-guards.ts).
 */

import { mock } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

type SpawnSpec = { role: string; prompt: string; cwd?: string };
let reviewerReply = "";
const spawnCalls: string[] = [];
const ledgerResults: Array<{ loopOutcome?: string; callerSuppliedDiff?: boolean }> = [];
const capturedJobs: Array<{ work: (s: AbortSignal, h: { jobId: string }) => Promise<unknown> }> =
  [];

mock.module(new URL("../src/spawn.ts", import.meta.url).href, () => ({
  makeRunId: () => "run-1161",
  spawnSpecialist: async (spec: SpawnSpec) => {
    spawnCalls.push(spec.role);
    return { role: spec.role, ok: true, text: reviewerReply, toolUses: [], ms: 1, exitCode: 0 };
  },
}));
const realLedger = await import("../src/adversarial-ledger.ts");
mock.module(new URL("../src/adversarial-ledger.ts", import.meta.url).href, () => ({
  ...realLedger,
  writeAdversarialLedgerEntry: (
    r: { loopOutcome?: string },
    p: { callerSuppliedDiff?: boolean },
  ): Promise<void> => {
    ledgerResults.push({ loopOutcome: r.loopOutcome, callerSuppliedDiff: p.callerSuppliedDiff });
    return Promise.resolve();
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
const realAsync = await import("../src/async-jobs.ts");
mock.module(new URL("../src/async-jobs.ts", import.meta.url).href, () => ({
  ...realAsync,
  startJob: (_pi: unknown, spec: (typeof capturedJobs)[number]) => {
    capturedJobs.push(spec);
    return { jobId: "job-tool" };
  },
}));

const { runAdversarialLoop } = await import("../src/adversarial.ts");
const { registerAdversarialTool } = await import("../src/adversarial-tool.ts");

const APPROVED = "VERDICT: APPROVED\n\nlooks good";
const REVIEW = "VERDICT: ISSUES_FOUND\n\n- x.txt:1 - missing test";
const signal = () => new AbortController().signal;
const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });

const callerRepo = mkdtempSync(path.join(os.tmpdir(), "adv-1161-caller-"));
git(callerRepo, "init", "-q", "-b", "main");
git(callerRepo, "config", "user.email", "t@example.com");
git(callerRepo, "config", "user.name", "test");
writeFileSync(path.join(callerRepo, "f.txt"), "one\n");
git(callerRepo, "add", "-A");
git(callerRepo, "commit", "-q", "-m", "base");
const workBase = mkdtempSync(path.join(os.tmpdir(), "adv-1161-wt-"));
const workRepo = path.join(workBase, "wt");
git(callerRepo, "worktree", "add", "-q", "-b", "wt-1161", workRepo);
writeFileSync(path.join(workRepo, "ranged.txt"), "ranged\n");
git(workRepo, "add", "ranged.txt");
git(workRepo, "commit", "-q", "-m", "ranged change");

let registered: { execute: (id: string, raw: unknown) => Promise<unknown> } | undefined;
registerAdversarialTool({
  registerTool: (t: unknown) => {
    registered = t as typeof registered;
  },
} as never);

/**
 * The rows below carry policy values the `ReportPolicy` union forbids, which is
 * the point — they exist to reach the runtime fence. `PolicyRow` keeps the two
 * policy keys checked (each `unknown`, so a bad VALUE is still expressible);
 * `policyParams` is the one unsound widening this file needs, so the rows keep
 * their literal values and a typo'd key is still a compile error (TS2561).
 */
type AdversarialParams = Parameters<typeof runAdversarialLoop>[0];
type PolicyRow = { reportOnly?: unknown; reportVerdict?: unknown };
const policyParams = (params: PolicyRow) => params as unknown as AdversarialParams;

/**
 * A policy rejection the caller sees, spelled exactly as the fence writes it:
 * the arm's reason, then the two values a policy is allowed to take.
 */
const policyText = (reason: string) =>
  `Adversarial loop infrastructure failure: ${reason} (reportVerdict must be "terminal" or "routed"). No verdict was produced — this is NOT a review rejection.`;

/**
 * K: the reportOnly rows with no usable verdict policy. Each row is
 * `[label, policy, text]` and carries the FULL policy the loop receives —
 * nothing is injected at the call site — so deleting the spread that hands it
 * over changes the outcome and fails the row. `absent` omits `reportVerdict`
 * and is rejected as the missing policy; `bogus` sets a value the fence does
 * not recognise and is rejected as that value, so the two rows cannot pass on
 * each other's text.
 */
const K_POLICY_ROWS: Array<[label: string, policy: PolicyRow, text: string]> = [
  ["absent", { reportOnly: true }, policyText("reportOnly review without a verdict policy")],
  [
    "bogus",
    { reportOnly: true, reportVerdict: "bogus" },
    policyText('reportVerdict "bogus" is not a verdict policy'),
  ],
];

/**
 * M: the rows whose reportOnly / reportVerdict combination the fence must
 * reject. Each row carries the FULL policy and the exact reason its own arm of
 * `reportPolicyError` returns: a non-boolean reportOnly (string and null), and a
 * reportVerdict with no reportOnly (absent and explicitly false). The arm texts
 * are asserted pairwise distinct below, so a row cannot pass by landing on the
 * other arm's reason.
 */
const M_POLICY_ROWS: Array<[label: string, policy: PolicyRow, text: string]> = [
  [
    "reportOnly-not-boolean",
    { reportOnly: "yes", reportVerdict: "terminal" },
    policyText("reportOnly must be a boolean when set"),
  ],
  ["reportOnly-null", { reportOnly: null }, policyText("reportOnly must be a boolean when set")],
  [
    "orphan-verdict",
    { reportVerdict: "terminal" },
    policyText("reportVerdict requires reportOnly"),
  ],
  [
    "verdict-with-reportOnly-false",
    { reportOnly: false, reportVerdict: "routed" },
    policyText("reportVerdict requires reportOnly"),
  ],
];

/** Start the tool with `raw` arguments and run the job it dispatched. */
async function runTool(raw: Record<string, unknown>, reviewText: string) {
  reviewerReply = reviewText;
  ledgerResults.length = 0;
  capturedJobs.length = 0;
  if (!registered) throw new Error("adversarial_loop tool was not registered");
  await registered.execute("call-1161", raw);
  const job = capturedJobs.at(-1);
  if (!job) throw new Error("adversarial_loop did not start a job");
  await job.work(signal(), { jobId: "job-tool" });
  return ledgerResults.at(-1);
}

try {
  /**
   * One malformed-policy row: the loop rejects it as an infra-failure whose
   * text is EXACTLY the reason its own fence arm returns, dispatches nobody,
   * and records the infra-failure in the ledger. `policy` is the whole policy
   * — the row owns every policy key — so the assertions fail if the loop stops
   * receiving it.
   */
  async function expectInfraFailure(
    prefix: string,
    policy: PolicyRow,
    text: string,
    context: string,
    jobId: string,
  ) {
    spawnCalls.length = 0;
    ledgerResults.length = 0;
    const result = await runAdversarialLoop(
      policyParams({
        diff: "diff --git a/f b/f\n+x",
        context,
        workCwd: workRepo,
        ...policy,
      }),
      signal(),
      jobId,
    );
    assert(
      result.ok === false && result.loopOutcome === "infra-failure",
      `${prefix}: infra-failure with ok:false`,
    );
    assert(result.text === text, `${prefix}: the result is exactly the expected rejection`);
    assert(spawnCalls.length === 0, `${prefix}: no reviewer or developer is dispatched`);
    assert(
      ledgerResults.at(-1)?.loopOutcome === "infra-failure",
      `${prefix}: the ledger row is an infra-failure`,
    );
  }

  // ------------------------------------------------ K. no verdict policy → infra
  for (const [label, policy, text] of K_POLICY_ROWS) {
    // A reportOnly review whose verdict the loop cannot judge: the reviewer
    // would otherwise be judged as a routed round, which is the bug.
    reviewerReply = APPROVED;
    await expectInfraFailure(`K(${label})`, policy, text, "nopolicy", "job-k");
  }

  // ------------------------------- M. malformed reportOnly / orphan verdict → infra
  const mTexts = M_POLICY_ROWS.map(([, , text]) => text);
  assert(
    new Set(mTexts).size === 2 && mTexts[0] !== undefined && mTexts[0] !== mTexts[2],
    "M: the four rows cover two distinct arms, two rows each",
  );
  for (const [label, policy, text] of M_POLICY_ROWS) {
    await expectInfraFailure(`M(${label})`, policy, text, "malformed", "job-m");
  }

  // ------------------------------------- L. the tool boundary sets the flag
  const pasted = await runTool(
    {
      diff: "diff --git a/f b/f\n+x",
      context: "pasted",
      workCwd: workRepo,
      reportOnly: true,
      callerSuppliedDiff: false,
    },
    REVIEW,
  );
  assert(
    pasted?.callerSuppliedDiff === true,
    "L: a pasted diff is recorded as caller-supplied (a raw argument cannot clear the flag)",
  );

  const ranged = await runTool(
    { base: "main", head: "wt-1161", context: "ranged", workCwd: workRepo, reportOnly: true },
    REVIEW,
  );
  assert(
    ranged?.callerSuppliedDiff === false && ranged?.loopOutcome === "approved",
    "L: the same review via base+head is not caller-supplied and is recorded as approved",
  );
} finally {
  rmSync(workBase, { recursive: true, force: true });
  rmSync(callerRepo, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
