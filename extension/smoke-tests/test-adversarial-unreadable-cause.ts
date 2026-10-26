#!/usr/bin/env bun
/**
 * #1634 (M2) — an unreadable adversarial diff is an ENVIRONMENT fact, never a
 * provider fault. Split out of test-adversarial-unreadable-diff.ts (§12 file
 * size limit); that file keeps the gate's read/routing half, this one the cause
 * taxonomy's half.
 *
 * Before this, the outcome was `infra: true` with git's text in `errorTail`, and
 * `classifyAdversarialOutcome` fed that to the taxonomy as `providerMessage` — so
 * a host fault was reported as `provider-severed` (an outage that never
 * happened), the retry ladder treated it as transient, and the headless
 * `failure.kind` was `process`, which hosts re-queue. Each of those is a separate
 * assertion below.
 *
 * Offline: no spawn, no network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExecFn } from "../src/worktree.ts";
import type { DispatchResult } from "../src/types.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { scratchDirWithoutGit } from "./lib/git-worktree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

const dirs: string[] = [];
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
function tempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "adv-unreadable-cause-"));
  dirs.push(dir);
  return dir;
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
// ===========================================================================
// T7 — an unreadable diff never reaches the aggregate's approved branch, and
//      the step handler parks with the infra cap rather than approving.
// ===========================================================================
{
  const { runAdversarial } = await import("../src/work-driver-adversarial.ts");
  const dir = tempRepo();
  // A FIRST pass deliberately leaves the `dispatch-failed` tail for the step
  // router's RETRY_ONCE path (#486) rather than parking, so this fixture seeds
  // the prior-outcome record that makes the failure final — the state a resumed
  // cycle reaches, and the one whose routing must not be an approval.
  const seeded: WorkState = {
    ...seedState(
      dir,
      { default: scratchDirWithoutGit("adv-unreadable-step-", { "a.ts": "a\n" }) },
      1638,
    ),
    eventLog: [
      {
        kind: "adversarial-workstream-outcome",
        at: Date.now(),
        workstreamId: "default",
        outcome: "infra-failure",
        roundsExecuted: 0,
      },
    ],
  };
  const { ctx } = ctxFor(dir, 1638, approvedLoop);
  const out = await runAdversarial(ctx as never, seeded, Date.now());
  const approved = out.eventLog.filter((e) => e.kind === "adversarial-approved");
  const skipped = out.eventLog.filter((e) => e.kind === "adversarial-skipped-empty-diff");
  assert(approved.length === 0, "T7: the gate records no approval for an unreadable diff");
  assert(skipped.length === 0, "T7: the gate records no empty-diff skip for an unreadable diff");
  const cap = [...out.eventLog].reverse().find((e) => e.kind === "cap-hit");
  assert(
    cap !== undefined && cap.kind === "cap-hit" && cap.nextStep === "handoff",
    "T7: the cycle is routed to a handoff, not onward to commit-pr",
  );
  assert(
    cap?.kind === "cap-hit" && cap.cap === "adversarial-infra-failure",
    `T7: it parks with the existing infra cap, not a rejection (got ${cap?.kind === "cap-hit" ? cap.cap : "none"})`,
  );
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
