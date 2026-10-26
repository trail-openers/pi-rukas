#!/usr/bin/env bun
/**
 * #1634 — the adversarial gate must never approve a diff it could not read.
 *
 * `fetchDiff` answered the empty string for EVERY failure mode, and the gate's
 * #286 empty-diff short-circuit renders an empty string as
 * `adversarial-skipped-empty-diff` + `ok: true` + `rounds: 0`: a worktree whose
 * diff could not be read cleared the pre-commit gate with no reviewer ever
 * seeing it. The lens path had the same defect and got the #384 fix (a
 * discriminated read that establishes "empty" POSITIVELY); this is the same fix
 * on the per-worktree read.
 *
 * Covers, in order:
 *  - a readable non-empty diff is unchanged (the reviewer receives it);
 *  - a genuinely clean worktree still skips, exactly as #286 intended — and
 *    stays provable clean through the DRIVER's own `.pi/` / `tmp/` records,
 *    which live in the tree the gate reads (a naive dirt check would make every
 *    real cycle unreadable and turn this gate into one that parks everything);
 *  - an UNREADABLE diff — git failing, or the directory not being a repository
 *    at all — yields NO approval and NO skip event, and routes as an
 *    infrastructure failure (`infra: true`, `ok: false`, a `dispatch-failed`
 *    event) rather than as an empty-diff pass;
 *  - N>1: one unreadable workstream is an infra failure while its readable
 *    sibling is still reviewed, and the aggregate records no approval;
 *  - `readWorktreeDiff`'s own contract for a missing cwd, a dirt-only tree, a
 *    tracked modification, and a git binary that fails (an injected failing
 *    `exec`, never a mutated `PATH`);
 *  - an unreadable diff is an ENVIRONMENT fact, never a provider fault: it
 *    carries a structured non-retryable cause, its stderr is never handed to
 *    the provider classifier, and the retry ladder spends no wait on it;
 *  - the per-round re-read (`getDiff`) thrown by the REAL fan-out rejects on a
 *    failed read rather than resolving to "", so a round cannot review and
 *    approve "no changes";
 *  - the step handler parks with `adversarial-infra-failure` rather than
 *    approving, when the diff cannot be read.
 *
 * Offline: no spawn, no network. Fixtures use the real-git helpers in
 * smoke-tests/lib/git-worktree-fixture.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecFn } from "../src/worktree.ts";
import type { DispatchResult } from "../src/types.ts";
import { fanOutAdversarial } from "../src/work-driver-adversarial-fanout.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { readWorktreeDiff } from "../src/work-driver-diff.ts";
import { __setSleepFn } from "../src/work-driver-step-router.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import {
  commitAll,
  execFailingArgs,
  passthroughExec,
  failingExec,
  gitFixture,
  initScratchRepoFresh,
  scratchDir,
  scratchDirWithoutGit,
  seedFile,
  stageFile,
} from "./lib/git-worktree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** The dirt probe `readWorktreeDiff` runs to decide what a BLANK diff means. */
const DIRTY_PROBE_READ = "git status --porcelain -z --untracked-files=all";

const dirs: string[] = [];
// WHY THIS FILE HUNG FOR ~40 MINUTES (the previous dispatch died on a timeout
// kill at T3b): the unreadable read is TRANSIENT to the taxonomy, so the fan-out
// runs its in-step retry ladder before reporting the failure, and an unreadable
// worktree never becomes readable — so the ladder always spends its whole
// budget. #1243 gave provider-class causes a 60s-per-attempt FLOOR on top of the
// old `5s × attempt` knob, and `PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS` feeds the
// LINEAR rung only: the floor is a `Math.max`, so zeroing that knob changes
// nothing for a provider-class failure. One unreadable case therefore slept
// minutes. The waits are not what these tests assert, so they are recorded
// instead of slept, through the one seam every provider wait in the driver takes
// (#1243 made the fan-out share `providerSleep` with the step router for exactly
// this reason). The env overrides stay as defence-in-depth: a run without the
// seam still finishes inside its bound rather than hanging.
const providerWaits: number[] = [];
let harnessSlept = false;
const restoreSleep = __setSleepFn(async (ms) => {
  if (ms > 0) harnessSlept = true;
  providerWaits.push(ms);
});
process.env.PI_ENSEMBLE_TRANSIENT_RETRY = "1";
process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_PROVIDER_RETRY_FLOOR_MS = "0";
process.env.PI_ENSEMBLE_PROVIDER_RETRY_MAX_WAIT_MS = "0";
function tempRepo(): string {
  const dir = initScratchRepoFresh("adv-unreadable-");
  dirs.push(dir);
  return dir;
}
function seedState(dir: string, worktrees: Record<string, string>, issue: number): WorkState {
  const ids = Object.keys(worktrees);
  const workstreams: Record<
    string,
    { id: string; scope: string; paths: string[]; outOfScope: string[] }
  > = {};
  for (const id of ids) workstreams[id] = { id, scope: `scope ${id}`, paths: [], outOfScope: [] };
  return {
    ...initialState(issue, 1_000_000),
    pipelineState: {
      ...initialState(issue, 1_000_000).pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
      worktrees,
      workstreams,
      branchName: `feature/issue-${issue}`,
    },
  };
}

function ctxFor(
  repoRoot: string,
  issue: number,
  onLoop: () => DispatchResult,
): { ctx: CycleContext; calls: () => number } {
  let calls = 0;
  const ctx = {
    host: { sendUserMessage: () => {} },
    repoRoot,
    issue,
    adversarialLoopFn: async () => {
      calls++;
      return onLoop();
    },
  } as never as CycleContext;
  return { ctx, calls: () => calls };
}

/** The same, with the fan-out's DIFF READ handed a specific executor (the #1634 seam). */
function ctxForExec(
  repoRoot: string,
  issue: number,
  exec: ExecFn,
): { ctx: CycleContext; calls: () => number; captured: () => Array<() => Promise<string>> } {
  let calls = 0;
  const getDiffs: Array<() => Promise<string>> = [];
  const ctx = {
    host: { sendUserMessage: () => {} },
    repoRoot,
    issue,
    diffExecFn: exec,
    adversarialLoopFn: async (params: { getDiff: () => Promise<string> }) => {
      calls++;
      getDiffs.push(params.getDiff);
      return approvedLoop();
    },
  } as never as CycleContext;
  return { ctx, calls: () => calls, captured: () => getDiffs };
}

const approvedLoop = (): DispatchResult => ({
  role: "adversarial-loop",
  ok: true,
  text: "APPROVED after round 1",
  toolUses: [],
  ms: 10,
  exitCode: 0,
  transcriptPath: "/tmp/stub.json",
  loopOutcome: "approved",
  adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
});

// ===========================================================================
// T1 — a readable non-empty diff: unchanged behaviour (the reviewer sees it)
// ===========================================================================
{
  const dir = tempRepo();
  seedFile(dir, "foo.ts", "export const a = 1;\n");
  stageFile(dir, "foo.ts");
  const seen: string[] = [];
  const ctx = {
    host: { sendUserMessage: () => {} },
    repoRoot: dir,
    issue: 1634,
    adversarialLoopFn: async (params: { diff: string }) => {
      seen.push(params.diff);
      return approvedLoop();
    },
  } as never;
  const { next, outcomes } = await fanOutAdversarial(
    ctx,
    seedState(dir, { default: dir }, 1634),
    ["default"],
    new Map(),
    false,
    null,
  );
  assert(seen.length === 1, "T1: the reviewer was dispatched once for a real diff");
  assert((seen[0] ?? "").includes("export const a = 1"), "T1: the reviewer received the diff");
  assert(outcomes[0]?.ok === true, "T1: outcome ok for a readable diff");
  assert(outcomes[0]?.skipped === false, "T1: no skip for a readable diff");
  assert(
    !next.eventLog.some((e) => e.kind === "adversarial-skipped-empty-diff"),
    "T1: no empty-diff skip event",
  );
}

// ===========================================================================
// T2 — a genuinely empty diff still skips (the #286 behaviour is preserved)
// ===========================================================================
{
  const dir = tempRepo();
  // The driver's own records in the tree it reads: they are NOT work, and the
  // empty case must survive them (the state file lives inside the worktree).
  seedFile(dir, ".pi/work-state/1635.json", "{}\n");
  seedFile(dir, "tmp/issue-1635/diff.txt", "scratch\n");

  const read = await readWorktreeDiff(dir, undefined);
  assert(
    read.ok === true && read.empty === true,
    `T2: the driver's own .pi/ and tmp/ records are not dirt (${read.ok ? "read ok" : read.reason})`,
  );

  const { ctx, calls } = ctxFor(dir, 1635, approvedLoop);
  const { next, outcomes } = await fanOutAdversarial(
    ctx,
    seedState(dir, { default: dir }, 1635),
    ["default"],
    new Map(),
    false,
    null,
  );
  assert(calls() === 0, "T2: no reviewer dispatch for a genuinely empty diff");
  assert(outcomes[0]?.skipped === true, "T2: outcome skipped for a genuinely empty diff");
  const skips = next.eventLog.filter((e) => e.kind === "adversarial-skipped-empty-diff");
  assert(skips.length === 1, "T2: one adversarial-skipped-empty-diff event");
  assert(
    outcomes[0]?.ok === true,
    "T2: a confirmed-empty workstream counts as ok for the aggregate",
  );
  assert(
    !next.eventLog.some((e) => e.kind === "dispatch-failed"),
    "T2: no failure event for an empty diff",
  );

  // A tracked edit under `.pi/` is NOT driver residue: it is the developer's
  // work and the gate must see it (the protected-path check #406 depends on it).
  const tracked = tempRepo();
  seedFile(tracked, ".pi/verify-cmd", "bun test\n");
  commitAll(tracked, "baseline with .pi/verify-cmd");
  seedFile(tracked, ".pi/verify-cmd", "bun test --changed\n");
  const t = await readWorktreeDiff(tracked, undefined);
  assert(t.ok === true && t.empty === false, "T2b: a tracked .pi/ edit is a diff, not residue");
}

// ===========================================================================
// T3 — an UNREADABLE diff: no approval, no skip, routed as an infra failure
// ===========================================================================
async function unreadableCase(
  name: string,
  worktree: string,
  how: "plain" | "git-fails",
): Promise<void> {
  const issue = how === "plain" ? 1636 : 1639;
  const repoRoot = tempRepo();
  // M3a — the failing executor is INJECTED, not installed by rewriting PATH:
  // the whole fan-out sees it (the retry ladder re-reads the tree on every
  // attempt, and a read that succeeded on attempt 2 would approve a diff nobody
  // reviewed — the exact defect this file pins), it is scoped to this one
  // fixture, and no sibling test's git child can race with it.
  const { ctx, calls } = ctxForExec(repoRoot, issue, failingExec());
  const state = seedState(repoRoot, { default: worktree }, issue);
  const { next, outcomes } = await fanOutAdversarial(
    ctx,
    state,
    ["default"],
    new Map(),
    false,
    null,
  );
  const o = outcomes[0];
  assert(calls() === 0, `${name}: no reviewer dispatched when the diff could not be read`);
  assert(o?.ok === false, `${name}: the outcome is NOT ok (no approval)`);
  assert(o?.skipped === false, `${name}: the outcome is not a skip`);
  assert(o?.infra === true, `${name}: the outcome is an infrastructure failure`);
  assert(o?.rounds === 0, `${name}: zero rounds executed`);
  assert(
    !next.eventLog.some((e) => e.kind === "adversarial-approved"),
    `${name}: NO adversarial-approved event`,
  );
  assert(
    !next.eventLog.some((e) => e.kind === "adversarial-skipped-empty-diff"),
    `${name}: NO adversarial-skipped-empty-diff event`,
  );
  const failed = next.eventLog.filter((e) => e.kind === "dispatch-failed");
  // One event per ATTEMPT, not per workstream: the ladder re-runs `runOne`
  // while its budget holds, so each attempt records its own failure. What is
  // load-bearing is that every attempt failed the same way and none approved.
  assert(failed.length >= 1, `${name}: a dispatch-failed event records the unreadable read`);
  assert(
    failed.every((e) => e.kind === "dispatch-failed" && /unreadable/i.test(e.errorTail ?? "")),
    `${name}: every attempt failed on the unreadable diff`,
  );
  assert(
    next.eventLog.filter((e) => e.kind === "dispatch-completed").length === 0,
    `${name}: no attempt ever completed`,
  );
  // Proof the hang is fixed: whatever the ladder decided to wait, the wait
  // never reached a real timer (the guard T3b/T3c used to sleep past is now
  // asserted once, at the end, over every case in the file).
  assert(
    !harnessSlept,
    `${name}: the retry ladder's waits were recorded, not slept (${providerWaits.length} waits)`,
  );
}
{
  // (a) the worktree path is a plain directory — no repository at all.
  const plain = scratchDirWithoutGit("adv-unreadable-norepo-", {
    "src/a.ts": "export const a = 1;\n",
    "README.md": "# not a repo\n",
  });
  dirs.push(plain);
  await unreadableCase("T3a: directory that is not a git repository", plain, "plain");
  // (b) the worktree path is gone entirely.
  await unreadableCase(
    "T3b: worktree path that does not exist",
    path.join(scratchDir("adv-unreadable-gone-"), "no-such-worktree"),
    "plain",
  );
  // (c) git itself fails on a real, clean worktree — the read must not answer
  // "nothing to review" because the binary could not run.
  const real = tempRepo();
  await unreadableCase("T3c: git itself fails (broken/uninstalled binary)", real, "git-fails");
}

// ===========================================================================
// T4 — N>1: one unreadable workstream never lets the aggregate approve
// ===========================================================================
{
  const good = tempRepo();
  seedFile(good, "bar.ts", "export const b = 2;\n");
  stageFile(good, "bar.ts");
  const bad = scratchDirWithoutGit("adv-unreadable-sibling-", { "x.ts": "x\n" });
  dirs.push(bad);
  const { ctx, calls } = ctxFor(good, 1637, approvedLoop);
  const { next, outcomes } = await fanOutAdversarial(
    ctx,
    seedState(good, { "task-a": good, "task-b": bad }, 1637),
    ["task-a", "task-b"],
    new Map(),
    false,
    null,
  );
  assert(calls() === 1, "T4: the readable workstream was still reviewed");
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  assert(byId.get("task-a")?.ok === true, "T4: the readable sibling approved");
  assert(byId.get("task-b")?.infra === true, "T4: the unreadable sibling is an infra failure");
  assert(byId.get("task-b")?.skipped === false, "T4: the unreadable sibling is not a skip");
  assert(
    !next.eventLog.some((e) => e.kind === "adversarial-approved"),
    "T4: the aggregate does not approve over an unreadable sibling",
  );
}


// ===========================================================================
// T8 — an unreadable diff is an ENVIRONMENT fact, never a provider fault.
//      Before this, the outcome was `infra: true` with git's text in
//      `errorTail`, and `classifyAdversarialOutcome` fed that to the taxonomy
//      as `providerMessage` — so a host fault was reported as `provider-severed`
//      (an outage that never happened), the retry ladder treated it as
//      transient, and the headless `failure.kind` was `process`, which hosts
//      re-queue. Each of those is a separate assertion below.
// ===========================================================================
{
  const { classifyAdversarialOutcome } = await import("../src/work-driver-adversarial-reentry.ts");
  const { classifyFailureCause } = await import("../src/work-driver-failure-taxonomy.ts");
  const { unreadableDiffOutcome } = await import("../src/work-driver-adversarial-types.ts");

  const o = unreadableDiffOutcome({
    id: "default",
    label: "adversarial_loop",
    multi: false,
    cwd: "/tmp/no-such-worktree",
    startedAt: Date.now(),
    orchestratorJobId: "job-t8",
    // Provider-shaped text in git's message: if anything read this as provider
    // prose, the classifier would say `provider-severed` and the ladder would
    // buy a minutes-floor wait. The structured cause must win outright.
    reason: "git diff HEAD failed: Request timed out. 429 requested 59s retry delay",
    readFailed: "git diff HEAD",
    priorInfra: false,
  });

  assert(
    o.structuredCause === "environment:diff-unreadable",
    `T8a: the outcome STATES its cause (got ${o.structuredCause})`,
  );
  assert(o.readFailed === "git diff HEAD", "T8b: the outcome names the read that failed");

  const cls = classifyAdversarialOutcome(o);
  assert(
    cls.cause === "environment:diff-unreadable",
    `T8c: the taxonomy reports the environment cause, not a provider one (got ${cls.cause})`,
  );
  assert(cls.shouldRetry === false, "T8d: an unreadable diff is NOT retryable");
  assert(cls.maxRetries === 0, "T8e: zero retries — re-spawning asks git the same question");
  assert(
    !o.infra || classifyAdversarialOutcome(o).cause !== "provider-severed",
    "T8f: the provider-class cause the old shape produced is gone",
  );

  // git's stderr must not reach the classifier AS PROVIDER TEXT: even handed a
  // provider-shaped message directly, the structured cause is what answers.
  const direct = classifyFailureCause({
    kind: "dispatch-failed-provider",
    providerMessage: "429 requested 59s retry delay",
    structuredCause: "environment:diff-unreadable",
  });
  assert(
    direct.cause === "environment:diff-unreadable" && direct.shouldRetry === false,
    `T8g: a structured cause is never overridden by provider-shaped prose (got ${direct.cause})`,
  );

  // The same event, read the way the driver's cause surfaces read it.
  const { failureOf } = await import("../src/headless/failure.ts");
  const dir = tempRepo();
  const state: WorkState = {
    ...seedState(dir, { default: scratchDirWithoutGit("adv-unreadable-t8-", {}) }, 1643),
    eventLog: [
      { kind: "step-started", step: "adversarial", at: Date.now() },
      ...(o.failureEvent ? [o.failureEvent] : []),
      {
        kind: "cap-hit" as const,
        at: Date.now(),
        cap: "adversarial-infra-failure" as const,
        reviewRound: 0,
        nextStep: "handoff" as const,
      },
    ],
  };
  const f = failureOf(state, "adversarial-infra-failure", "adversarial");
  assert(
    f?.cause === "environment:diff-unreadable",
    `T8h: the headless failure reports the environment cause (got ${f?.cause})`,
  );
  assert(
    f?.kind === "environment",
    `T8i: failure.kind is environment so a host does not re-queue it as a crash (got ${f?.kind})`,
  );
  assert(
    f?.structuredCause === "environment:diff-unreadable",
    `T8j: the producer's cause is surfaced alongside the inferred one (got ${f?.structuredCause})`,
  );

  // And the operator-facing explanation names the class, the read, and the fact
  // that the ladder deliberately did not retry.
  const { explainCap } = await import("../src/work-driver-explain.ts");
  const why = explainCap("adversarial-infra-failure", state);
  assert(
    /environment:diff-unreadable/.test(why),
    "T8k: the handoff's cause line carries the environment cause",
  );
  assert(
    /git diff HEAD/.test(why),
    "T8l: the handoff names the READ that failed, not just its class",
  );
  assert(
    /did NOT re-run it/.test(why),
    "T8m: the handoff says the retry ladder declined, so the operator does not wait for a retry",
  );
}

restoreSleep();
// The point of the ladder assertion is NOT that the ladder ran — it is that
// NOTHING in this file slept. The previous dispatch hung because the ladder
// slept for real, so the guard is that no wait ever reached the timer. (The
// unreadable outcome is deliberately NON-retryable — `isTransient` is false for
// it — so the correct count here is zero, and asserting a positive count would
// pin behaviour the fan-out does not have.)
assert(!harnessSlept, "no provider-ladder wait was actually slept — this file cannot hang on it");
assert(
  providerWaits.length === 0,
  `the unreadable route spends no retry-ladder waits (${providerWaits.length} recorded: ${providerWaits.join(",")})`,
);
for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
