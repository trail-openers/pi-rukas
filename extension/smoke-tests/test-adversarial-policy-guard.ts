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
import { policyInfraFailureText, reportPolicyError } from "../src/adversarial-policy.ts";

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
 * the point — they exist to reach the runtime fence. A row is
 * `[label, policy, reason]`: `policy` carries the raw values the fence sees and
 * `reason` is the LITERAL the fence must return for them — the spec, written
 * here independently of the fence, never derived from it, so a fence that
 * answers something else for the same arm goes RED. The full call params are
 * built only at the `policyParams` boundary into `runAdversarialLoop`, which is
 * the one unsound widening this file needs — a typo'd key is still a compile
 * error (TS2561).
 */
type AdversarialParams = Parameters<typeof runAdversarialLoop>[0];
/** The policy keys as the rows write them: `unknown` so a bad VALUE is expressible. */
type RowPolicy = { reportOnly?: unknown; reportVerdict?: unknown };
/** The full call params, built only at the boundary into `runAdversarialLoop`. */
type PolicyParams = Omit<AdversarialParams, "reportOnly" | "reportVerdict"> & RowPolicy;
const policyParams = (params: PolicyParams) => params as unknown as AdversarialParams;

type PolicyRow = [label: string, policy: RowPolicy, reason: string];

/**
 * K: the reportOnly rows with no usable verdict policy. `absent` omits
 * `reportVerdict` and is rejected as the missing policy; `bogus` sets a value
 * the fence does not recognise. The two literals name two different arms, so
 * the rows cannot pass on each other's reason.
 */
const K_POLICY_ROWS: PolicyRow[] = [
  ["absent", { reportOnly: true }, "reportOnly review without a verdict policy"],
  [
    "bogus",
    { reportOnly: true, reportVerdict: "bogus" },
    "reportVerdict is not a recognised verdict policy",
  ],
];

/**
 * M: the rows whose reportOnly / reportVerdict combination the fence must
 * reject: a non-boolean reportOnly (string and null), and a reportVerdict with
 * no reportOnly (absent and explicitly false) — two arms, two rows each, so the
 * duplicated reasons are the shape of the group, not a copy error: the
 * two-by-two split is what the distinctness assertion below pins.
 */
const M_POLICY_ROWS: PolicyRow[] = [
  [
    "reportOnly-not-boolean",
    { reportOnly: "yes", reportVerdict: "terminal" },
    "reportOnly must be a boolean when set",
  ],
  ["reportOnly-null", { reportOnly: null }, "reportOnly must be a boolean when set"],
  ["orphan-verdict", { reportVerdict: "terminal" }, "reportVerdict requires reportOnly"],
  [
    "verdict-with-reportOnly-false",
    { reportOnly: false, reportVerdict: "routed" },
    "reportVerdict requires reportOnly",
  ],
];

/** Reset the job capture so a row can never read a sibling row's dispatch. */
const resetCapturedJobs = () => {
  capturedJobs.length = 0;
};

/** Start the tool with `raw` arguments and run the job it dispatched. */
async function runTool(raw: Record<string, unknown>, reviewText: string) {
  reviewerReply = reviewText;
  ledgerResults.length = 0;
  resetCapturedJobs();
  if (!registered) throw new Error("adversarial_loop tool was not registered");
  await registered.execute("call-1161", raw);
  const job = capturedJobs.at(-1);
  if (!job) throw new Error("adversarial_loop did not start a job");
  await job.work(signal(), { jobId: "job-tool" });
  return ledgerResults.at(-1);
}

try {
  /**
   * One malformed-policy row: the loop rejects it as an infra-failure whose text
   * is EXACTLY the production wrapper around this row's literal reason, and
   * dispatches nobody. The policy is checked against the fence separately, so a
   * row cannot borrow another row's reason.
   */
  async function expectInfraFailure(label: string, policy: RowPolicy, reason: string) {
    spawnCalls.length = 0;
    ledgerResults.length = 0;
    resetCapturedJobs();
    const result = await runAdversarialLoop(
      policyParams({
        diff: "diff --git a/f b/f\n+x",
        context: label,
        workCwd: workRepo,
        reportOnly: policy.reportOnly,
        reportVerdict: policy.reportVerdict,
      }),
      signal(),
      "job-policy-guard",
    );
    assert(
      reportPolicyError(policy) === reason,
      `${label}: the fence returns this row's literal reason`,
    );
    assert(
      result.ok === false && result.loopOutcome === "infra-failure",
      `${label}: infra-failure with ok:false`,
    );
    assert(
      result.text === policyInfraFailureText(reason),
      `${label}: the result is the production sentence around this row's reason`,
    );
    assert(spawnCalls.length === 0, `${label}: no reviewer or developer is dispatched`);
  }

  // ------------------------------------------------ K. no verdict policy → infra
  assert(
    new Set(K_POLICY_ROWS.map(([, , reason]) => reason)).size === K_POLICY_ROWS.length,
    "K: the literal reasons of the two rows are distinct",
  );
  for (const [label, policy, reason] of K_POLICY_ROWS) {
    // A reportOnly review whose verdict the loop cannot judge: the reviewer
    // would otherwise be judged as a routed round, which is the bug.
    reviewerReply = APPROVED;
    await expectInfraFailure(`K(${label})`, policy, reason);
  }

  // ------------------------------- M. malformed reportOnly / orphan verdict → infra
  assert(
    new Set(M_POLICY_ROWS.map(([, , reason]) => reason)).size === 2,
    "M: the four rows cover two distinct arms, two rows each",
  );
  for (const [label, policy, reason] of M_POLICY_ROWS) {
    await expectInfraFailure(`M(${label})`, policy, reason);
  }

  // ------------------------------------- L. the tool boundary sets the flag
  const pastedRow = await runTool(
    {
      diff: "diff --git a/f b/f\n+x",
      context: "pasted",
      workCwd: workRepo,
      reportOnly: true,
      callerSuppliedDiff: false,
    },
    REVIEW,
  );
  assert(pastedRow !== undefined, "L(pasted): the tool's review wrote a ledger row");
  assert(
    pastedRow?.callerSuppliedDiff === true,
    "L: a pasted diff is recorded as caller-supplied (a raw argument cannot clear the flag)",
  );

  const rangedRow = await runTool(
    { base: "main", head: "wt-1161", context: "ranged", workCwd: workRepo, reportOnly: true },
    REVIEW,
  );
  assert(rangedRow !== undefined, "L(ranged): the tool's review wrote a ledger row");
  assert(
    rangedRow?.callerSuppliedDiff === false,
    "L: the same review via base+head is not recorded as caller-supplied",
  );
} finally {
  rmSync(workBase, { recursive: true, force: true });
  rmSync(callerRepo, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
