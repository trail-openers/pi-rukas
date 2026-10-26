#!/usr/bin/env bun
/**
 * #1634 (M3) — the per-round re-read the REAL adversarial fan-out builds.
 * Split out of test-adversarial-unreadable-diff.ts (§12 file size limit).
 *
 * This is the case a unit test of `readWorktreeDiff` cannot pin: the fan-out
 * hands the review loop a `getDiff` closure, and rounds 2+ must not review (and
 * approve) the string `""` — the same defect one round deeper, where a reviewer
 * declares "no problems found" about changes it was never shown. So the test
 * drives the fan-out end-to-end, captures the closure from the injected loop,
 * and calls IT against a tree the read cannot establish. The old version of this
 * test re-implemented the closure in the test body, which asserted the test's
 * own copy rather than the code.
 *
 * Offline: no spawn, no network.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ExecFn } from "../src/worktree.ts";
import type { DispatchResult } from "../src/types.ts";
import { fanOutAdversarial } from "../src/work-driver-adversarial-fanout.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { __setSleepFn } from "../src/work-driver-step-router.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import {
  execFailingArgs,
  passthroughExec,
  gitFixture,
  initScratchRepoFresh,
  seedFile,
  stageFile,
} from "./lib/git-worktree-fixture.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`\u2713 ${msg}`);
  else {
    console.error(`\u2717 ${msg}`);
    exit = 1;
  }
}

const dirs: string[] = [];
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
  const dir = initScratchRepoFresh("adv-reread-");
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
function approvedLoop(): DispatchResult {
  return {
    role: "adversarial-loop",
    ok: true,
    text: "APPROVED after round 1",
    toolUses: [],
    ms: 10,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    loopOutcome: "approved",
    adversarialRounds: [{ round: 1, status: "APPROVED", verdictParsed: true }],
  };
}
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

// ===========================================================================
// T6 — the per-round re-read the REAL fan-out builds: a failed getDiff is not
//      an approvable "no changes". Driven end-to-end (a non-empty first diff
//      so the loop is reached, then the captured `params.getDiff` called
//      against a tree the read cannot establish) rather than by re-implementing
//      the closure in the test.
// ===========================================================================
{
  const dir = tempRepo();
  seedFile(dir, "foo.ts", "export const a = 1;\n");
  stageFile(dir, "foo.ts");
  // The FIRST read must succeed for the loop to be reached at all, so this
  // fixture injects an executor that fails only the DIRT PROBE — which is what
  // makes a blank re-read unreadable while a re-read with content still works.
  const { ctx, calls, captured } = ctxForExec(dir, 1640, execFailingArgs(["status", "--porcelain"]));
  const { outcomes } = await fanOutAdversarial(
    ctx,
    seedState(dir, { default: dir }, 1640),
    ["default"],
    new Map(),
    false,
    null,
  );
  assert(calls() === 1, "T6: a non-empty diff reaches the loop");
  assert(outcomes[0]?.ok === true, "T6: the readable round approved");
  const getDiff = captured()[0];
  assert(getDiff !== undefined, "T6: the fan-out passed the loop a getDiff");

  // With the dirt probe failing, a re-read of the same tree resolves through the
  // committed/staged content — but a tree whose diff is BLANK and whose probe
  // fails must REJECT. That is the case the old `""` answer smuggled into a
  // round as "no changes to review".
  const blankDir = tempRepo();
  const { ctx: blankCtx, captured: blankCaptured } = ctxForExec(
    blankDir,
    1641,
    execFailingArgs(["status", "--porcelain"]),
  );
  // Seed a non-empty FIRST read (staged) so the loop is reached, then remove
  // the staged content so the RE-READ is the blank-and-unprobeable shape.
  seedFile(blankDir, "bar.ts", "export const b = 2;\n");
  stageFile(blankDir, "bar.ts");
  await fanOutAdversarial(
    blankCtx,
    seedState(blankDir, { default: blankDir }, 1641),
    ["default"],
    new Map(),
    false,
    null,
  );
  const roundTwoGetDiff = blankCaptured()[0];
  assert(roundTwoGetDiff !== undefined, "T6b: the loop received a getDiff for the blank tree");
  // Unstage: the working tree is now blank and the probe is the failing one.
  gitFixture(blankDir, ["reset", "-q"]);
  let rejected = false;
  let resolvedTo = "<did not reject>";
  try {
    resolvedTo = JSON.stringify(await (roundTwoGetDiff ?? (async () => ""))());
  } catch (err) {
    rejected = true;
    resolvedTo = (err as Error).message;
  }
  assert(
    rejected && /re-read failed/.test(resolvedTo),
    `T6b: the fan-out's real getDiff REJECTS a blank diff it cannot prove clean (got ${resolvedTo})`,
  );

  // And an empty diff never reaches the loop at all (the #286 skip still fires).
  // The executor must be a WORKING one here: "empty" is proven by reading the
  // tree, so a failing executor would make this the unreadable case instead and
  // the assertion would prove nothing about the short-circuit.
  const emptyDir = tempRepo();
  const { ctx: emptyCtx, calls: emptyCalls } = ctxForExec(emptyDir, 1642, passthroughExec());
  const emptyRun = await fanOutAdversarial(
    emptyCtx,
    seedState(emptyDir, { default: emptyDir }, 1642),
    ["default"],
    new Map(),
    false,
    null,
  );
  assert(
    emptyCalls() === 0 && emptyRun.outcomes[0]?.skipped === true,
    "T6c: a proven-empty tree never reaches the loop at all",
  );
}

restoreSleep();
assert(!harnessSlept, "no provider-ladder wait was slept — this file cannot hang on it");
for (const d of dirs) rmSync(d, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
