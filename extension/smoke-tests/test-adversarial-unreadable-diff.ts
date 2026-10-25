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
 *    tracked modification, and `fetchDiff`'s best-effort string projection;
 *  - the per-round re-read (`getDiff`) throws on a failed read rather than
 *    resolving to "", so a round cannot review and approve "no changes";
 *  - the step handler parks with `adversarial-infra-failure` rather than
 *    approving, when the diff cannot be read.
 *
 * Offline: no spawn, no network. Fixtures use the real-git helpers in
 * smoke-tests/lib/git-worktree.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DispatchResult } from "../src/types.ts";
import { fanOutAdversarial } from "../src/work-driver-adversarial-fanout.ts";
import type { CycleContext } from "../src/work-driver-context.ts";
import { fetchDiff, readWorktreeDiff } from "../src/work-driver-diff.ts";
import { __setSleepFn } from "../src/work-driver-step-router.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import {
  commitAll,
  initScratchRepoFresh,
  scratchDir,
  scratchDirWithoutGit,
  seedFile,
  stageFile,
  withGitBroken,
} from "./lib/git-worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

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
  const { ctx, calls } = ctxFor(repoRoot, issue, approvedLoop);
  const state = seedState(repoRoot, { default: worktree }, issue);
  // `withGitBroken` stays in force for the WHOLE fan-out, not just the first
  // read: the retry ladder re-reads the tree on every attempt, and a read that
  // succeeded on attempt 2 would approve a diff nobody reviewed — the exact
  // defect this file pins. The sleeps are injected above, so no wait needs git.
  const { next, outcomes } = await withGitBroken(() =>
    fanOutAdversarial(ctx, state, ["default"], new Map(), false, null),
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
// T5 — readWorktreeDiff's own contract: empty vs unreadable vs non-empty
// ===========================================================================
{
  const noCwd = await readWorktreeDiff(undefined, undefined);
  assert(noCwd.ok === false, "T5a: no cwd is unreadable, never an empty diff");

  const dirty = tempRepo();
  seedFile(dirty, "untracked-new.ts", "x\n");
  const d = await readWorktreeDiff(dirty, undefined);
  assert(d.ok === false, "T5c: an untracked file with a blank diff is unreadable, not empty");
  assert(
    d.ok === false && /not clean/.test(d.reason),
    "T5c: the reason says the tree is not clean",
  );

  // A tracked modification still reads as a diff (no behaviour change).
  const modified = tempRepo();
  seedFile(modified, "a.txt", "one\n");
  commitAll(modified, "one");
  seedFile(modified, "a.txt", "two\n");
  const m = await readWorktreeDiff(modified, undefined);
  assert(m.ok === true && m.empty === false, "T5d: a tracked modification is a non-empty diff");

  // A non-repository directory with files in it is unreadable, not empty — the
  // case `git diff HEAD` answers blank for.
  const plain = scratchDirWithoutGit("adv-unreadable-plain2-", { "a.ts": "a\n" });
  dirs.push(plain);
  const p = await readWorktreeDiff(plain, undefined);
  assert(p.ok === false, "T5f: a directory that is not a git repo is unreadable, not empty");

  // With git removed from PATH, a REAL clean worktree is unreadable too.
  const real = tempRepo();
  const broken = await withGitBroken(() => readWorktreeDiff(real, undefined));
  assert(broken.ok === false, "T5g: a git binary that fails makes the read unreadable");

  // fetchDiff keeps its best-effort string contract for its other callers.
  const asString = await fetchDiff(undefined, undefined);
  assert(asString === "", "T5e: fetchDiff keeps returning '' for a caller that wants a string");
}

// ===========================================================================
// T6 — the per-round re-read: a failed getDiff is not an approvable "no changes"
// ===========================================================================
{
  // The fan-out hands the loop a `getDiff` that must THROW on a failed read
  // (adversarial.ts catches it and keeps the previous round's diff). Asserted
  // through the contract the fan-out builds it from: a re-read of a tree that
  // is not a repository rejects rather than resolving to "".
  const dir = tempRepo();
  const first = await readWorktreeDiff(dir, undefined);
  assert(first.ok === true && first.empty === true, "T6: the fixture tree starts clean-empty");
  const plain = scratchDirWithoutGit("adv-unreadable-reread-", { "a.ts": "a\n" });
  dirs.push(plain);
  let threw = false;
  try {
    const r = await readWorktreeDiff(plain, undefined);
    if (!r.ok) throw new Error(`diff re-read failed: ${r.reason}`);
  } catch (err) {
    threw = true;
    assert(
      /re-read failed/.test((err as Error).message),
      "T6: a failed re-read throws (it does not resolve to an empty string)",
    );
  }
  assert(threw, "T6: the re-read path throws for an unreadable tree");

  // And through the real loop: the `getDiff` the fan-out builds must reject.
  const seenGetDiff: Array<() => Promise<string>> = [];
  const ctx = {
    host: { sendUserMessage: () => {} },
    repoRoot: dir,
    issue: 1640,
    adversarialLoopFn: async (params: { getDiff: () => Promise<string> }) => {
      seenGetDiff.push(params.getDiff);
      return approvedLoop();
    },
  } as never;
  await fanOutAdversarial(
    ctx,
    seedState(dir, { default: dir }, 1640),
    ["default"],
    new Map(),
    false,
    null,
  );
  // The first read was empty, so the loop was never reached; drive getDiff
  // against a tree the read cannot establish instead.
  const plain2 = scratchDirWithoutGit("adv-unreadable-reread2-", { "b.ts": "b\n" });
  dirs.push(plain2);
  let rejected = false;
  try {
    const diff = await readWorktreeDiff(plain2, undefined);
    if (!diff.ok) throw new Error(`diff re-read failed: ${diff.reason}`);
  } catch {
    rejected = true;
  }
  assert(rejected, "T6b: a re-read of a non-repository rejects rather than approving empty");
  assert(seenGetDiff.length === 0, "T6c: an empty diff never reaches the loop at all");
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
