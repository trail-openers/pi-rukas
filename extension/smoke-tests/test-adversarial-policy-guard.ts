#!/usr/bin/env bun
/**
 * #1161 — the reportOnly verdict-policy guard, and the adversarial_loop tool
 * boundary's caller-supplied-diff flag.
 *
 *   - K: a reportOnly review with no recognised verdict policy (an untyped JS
 *     caller) is an infra-failure naming the policy. It dispatches nothing and
 *     is never judged as a routed round. A non-boolean reportOnly, or a
 *     reportVerdict without reportOnly, is refused the same way.
 *   - L: a diff pasted into the tool is recorded as caller-supplied; the same
 *     review via base+head is not. The tool sets the flag after the raw
 *     arguments, so a raw argument cannot clear it.
 *
 * Drives the REAL runAdversarialLoop and registerAdversarialTool over a real
 * git worktree. The spawn, deck and registry seams come from
 * adversarial-loop-helpers.ts; the ledger writer and async-jobs are mocked here.
 */

import { mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, installLoopSeams, newRepo } from "./adversarial-loop-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

let reviewerReply = "";
const spawnCalls: string[] = [];
const ledgerResults: Array<{ loopOutcome?: string; callerSuppliedDiff?: boolean }> = [];
const capturedJobs: Array<{ work: (s: AbortSignal, h: { jobId: string }) => Promise<unknown> }> =
  [];

await installLoopSeams(async (spec: { role: string }) => {
  spawnCalls.push(spec.role);
  return { role: spec.role, ok: true, text: reviewerReply, toolUses: [], ms: 1, exitCode: 0 };
});
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

const callerRepo = newRepo("adv-1161-caller-");
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

/** Run the loop with a raw (untyped) policy and assert it is refused without dispatch. */
async function refusedPolicy(label: string, policy: Record<string, unknown>, reason: string) {
  spawnCalls.length = 0;
  ledgerResults.length = 0;
  reviewerReply = APPROVED;
  const k = await runAdversarialLoop(
    { diff: "diff --git a/f b/f\n+x", context: label, workCwd: workRepo, ...policy } as never,
    signal(),
    "job-k",
  );
  assert(
    k.loopOutcome === "infra-failure" && k.ok === false,
    `K(${label}): refused as an infra-failure`,
  );
  assert(k.text.includes(reason), `K(${label}): the result names "${reason}"`);
  assert(spawnCalls.length === 0, `K(${label}): no reviewer or developer is dispatched`);
  assert(
    ledgerResults.at(-1)?.loopOutcome === "infra-failure",
    `K(${label}): the ledger row is an infra-failure`,
  );
}

try {
  // ------------------------------------------------ K. verdict-policy fence
  await refusedPolicy(
    "no policy",
    { reportOnly: true },
    "reportOnly review without a verdict policy",
  );
  await refusedPolicy(
    "bogus verdict",
    { reportOnly: true, reportVerdict: "bogus" },
    "reportOnly review without a verdict policy",
  );
  await refusedPolicy(
    "string reportOnly",
    { reportOnly: "true", reportVerdict: "terminal" },
    "reportOnly must be a boolean when set",
  );
  await refusedPolicy(
    "null reportOnly",
    { reportOnly: null, reportVerdict: "terminal" },
    "reportOnly must be a boolean when set",
  );
  await refusedPolicy(
    "verdict without reportOnly",
    { reportVerdict: "terminal" },
    "reportVerdict requires reportOnly",
  );
  await refusedPolicy(
    "verdict with reportOnly false",
    { reportOnly: false, reportVerdict: "routed" },
    "reportVerdict requires reportOnly",
  );

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
