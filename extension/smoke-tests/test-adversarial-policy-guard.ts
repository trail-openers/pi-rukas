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
import { reportPolicyError } from "../src/adversarial-policy.ts";

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
 * the point — they exist to reach the runtime fence. `PolicyParams` keeps the
 * non-policy keys checked and the two policy keys `unknown` (so a bad VALUE is
 * still expressible); `policyParams` is the one unsound widening this file needs,
 * so a typo'd key is still a compile error (TS2561).
 */
type AdversarialParams = Parameters<typeof runAdversarialLoop>[0];
type PolicyParams = Omit<AdversarialParams, "reportOnly" | "reportVerdict"> & {
  reportOnly?: unknown;
  reportVerdict?: unknown;
};
const policyParams = (params: PolicyParams) => params as unknown as AdversarialParams;

/** The wrapper `adversarial.ts` puts around the fence's reason. */
const POLICY_TEXT_PREFIX = "Adversarial loop infrastructure failure: ";
const POLICY_TEXT_SUFFIX =
  ' (reportVerdict must be "terminal" or "routed"). No verdict was produced — this is NOT a review rejection.';

/**
 * A policy rejection the caller sees, spelled exactly as the loop writes it:
 * the reason the fence returns, then the two values a policy is allowed to take.
 */
const policyText = (reason: string) => `${POLICY_TEXT_PREFIX}${reason}${POLICY_TEXT_SUFFIX}`;

/** The reason the fence returned, recovered from the full rejection text. */
const policyReason = (text: string) =>
  text.slice(POLICY_TEXT_PREFIX.length, -POLICY_TEXT_SUFFIX.length);

/** Each row is `[label, policy]`; the expected text is derived from the real fence. */
type PolicyRow = [label: string, policy: PolicyParams];

/**
 * K: the reportOnly rows with no usable verdict policy. `absent` omits
 * `reportVerdict` and is rejected as the missing policy; `bogus` sets a value
 * the fence does not recognise, so the two rows cannot pass on each other's text.
 */
const K_POLICY_ROWS: PolicyRow[] = [
  ["absent", { reportOnly: true }],
  ["bogus", { reportOnly: true, reportVerdict: "bogus" }],
];

/**
 * M: the rows whose reportOnly / reportVerdict combination the fence must
 * reject: a non-boolean reportOnly (string and null), and a reportVerdict with
 * no reportOnly (absent and explicitly false) — two arms, two rows each.
 */
const M_POLICY_ROWS: PolicyRow[] = [
  ["reportOnly-not-boolean", { reportOnly: "yes", reportVerdict: "terminal" }],
  ["reportOnly-null", { reportOnly: null }],
  ["orphan-verdict", { reportVerdict: "terminal" }],
  ["verdict-with-reportOnly-false", { reportOnly: false, reportVerdict: "routed" }],
];

/** Every row's expected text, derived from `reportPolicyError` itself. */
const rowsWithText = (
  rows: PolicyRow[],
): Array<[label: string, policy: PolicyParams, text: string]> =>
  rows.map(([label, policy]) => [label, policy, policyText(reportPolicyError(policy) ?? "")]);

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
   * One malformed-policy row: the loop rejects it as an infra-failure whose text
   * is EXACTLY the reason its own fence arm returns, and dispatches nobody.
   */
  async function expectInfraFailure(prefix: string, policy: PolicyParams, text: string) {
    spawnCalls.length = 0;
    ledgerResults.length = 0;
    /** The reason the row's policy must reach the fence with, derived from the row itself. */
    const reason = policyReason(text);
    assert(
      reportPolicyError(policy) === reason,
      `${prefix}: the fence returns this row's own reason`,
    );
    assert(
      policyText(reason) === text,
      `${prefix}: the loop's rejection text is the fence reason wrapped as documented`,
    );
    const result = await runAdversarialLoop(
      policyParams({
        diff: "diff --git a/f b/f\n+x",
        context: "policy-guard",
        workCwd: workRepo,
        ...policy,
      }),
      signal(),
      "job-policy-guard",
    );
    assert(
      result.ok === false && result.loopOutcome === "infra-failure",
      `${prefix}: infra-failure with ok:false`,
    );
    assert(result.text === text, `${prefix}: the result is exactly the expected rejection`);
    assert(spawnCalls.length === 0, `${prefix}: no reviewer or developer is dispatched`);
  }

  // ------------------------------------------------ K. no verdict policy → infra
  const kRows = rowsWithText(K_POLICY_ROWS);
  assert(
    new Set(kRows.map(([, policy]) => reportPolicyError(policy))).size === 2,
    "K: the two rows land on two distinct fence arms",
  );
  for (const [label, policy, text] of kRows) {
    // A reportOnly review whose verdict the loop cannot judge: the reviewer
    // would otherwise be judged as a routed round, which is the bug.
    reviewerReply = APPROVED;
    await expectInfraFailure(`K(${label})`, policy, text);
  }

  // ------------------------------- M. malformed reportOnly / orphan verdict → infra
  const mRows = rowsWithText(M_POLICY_ROWS);
  assert(
    new Set(mRows.map(([, policy]) => reportPolicyError(policy))).size === 2,
    "M: the four rows cover two distinct arms, two rows each",
  );
  for (const [label, policy, text] of mRows) {
    await expectInfraFailure(`M(${label})`, policy, text);
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
    ranged?.callerSuppliedDiff === false,
    "L: the same review via base+head is not recorded as caller-supplied",
  );
} finally {
  rmSync(workBase, { recursive: true, force: true });
  rmSync(callerRepo, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
