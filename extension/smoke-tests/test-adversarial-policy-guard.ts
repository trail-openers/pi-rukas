#!/usr/bin/env bun
/**
 * #1161 — the reportOnly verdict-policy guard, and the adversarial_loop tool
 * boundary's caller-supplied-diff flag.
 *
 *   - K: a reportOnly review with no recognised verdict policy (an untyped JS
 *     caller) is an infra-failure naming the policy. It dispatches nothing and
 *     is never judged as a routed round.
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
  // ------------------------------------------------ K. no verdict policy → infra
  for (const policy of [undefined, "bogus"]) {
    spawnCalls.length = 0;
    ledgerResults.length = 0;
    reviewerReply = APPROVED;
    const k = await runAdversarialLoop(
      {
        diff: "diff --git a/f b/f\n+x",
        context: "nopolicy",
        workCwd: workRepo,
        reportOnly: true,
        reportVerdict: policy as never,
      },
      signal(),
      "job-k",
    );
    const label = String(policy);
    assert(
      k.loopOutcome === "infra-failure" && k.ok === false,
      `K(${label}): reportOnly without a verdict policy is an infra-failure`,
    );
    assert(
      k.text.includes("reportOnly review without a verdict policy"),
      `K(${label}): the result names the missing policy`,
    );
    assert(spawnCalls.length === 0, `K(${label}): no reviewer or developer is dispatched`);
    assert(
      ledgerResults.at(-1)?.loopOutcome === "infra-failure",
      `K(${label}): the ledger row is an infra-failure`,
    );
  }

  // ------------------------------- M. malformed reportOnly / orphan verdict → infra
  const malformed: Array<[Record<string, unknown>, string]> = [
    [{ reportOnly: "yes", reportVerdict: "terminal" }, "reportOnly must be a boolean when set"],
    [{ reportOnly: null }, "reportOnly must be a boolean when set"],
    [{ reportVerdict: "terminal" }, "reportVerdict requires reportOnly"],
    [{ reportOnly: false, reportVerdict: "routed" }, "reportVerdict requires reportOnly"],
  ];
  for (const [policy, reason] of malformed) {
    spawnCalls.length = 0;
    const m = await runAdversarialLoop(
      {
        diff: "diff --git a/f b/f\n+x",
        context: "malformed",
        workCwd: workRepo,
        ...(policy as never),
      },
      signal(),
      "job-m",
    );
    const label = JSON.stringify(policy);
    assert(
      m.loopOutcome === "infra-failure" && m.text.includes(reason),
      `M(${label}): infra-failure naming "${reason}"`,
    );
    assert(spawnCalls.length === 0, `M(${label}): no reviewer or developer is dispatched`);
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
