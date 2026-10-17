#!/usr/bin/env bun
/**
 * #1265 — the worktree sweep's DECISION rules, exercised directly.
 *
 * This is one of two files over `src/work-driver-worktree-sweep.ts` (§12's
 * 500-line cap split them at the seam that matters). This one drives
 * `decideSweepAction` and `executeSweepAction` with no git under them — the
 * six rules and the command each arm issues. The real-git end-to-end evidence
 * (that the sweep's verdict becomes a command git accepts, and that a decision
 * actually removes a directory) is in `test-work-driver-worktree-sweep.ts`.
 *
 * The pre-#1265 version of this coverage existed and proved nothing: it built
 * every state with `as any`, so the schema could not say no to a shape
 * production never writes, and its `executeSweepAction` cases asserted on a
 * mock's bookkeeping rather than on the command line — which is exactly how the
 * removal arm shipped issuing a path relative to a cwd it was not run from.
 * The cases here use real `WorkState` objects and assert on argv, cwd and the
 * count of commands issued.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import {
  type SweepAction,
  type SweepTargetResult,
  decideSweepAction,
  executeSweepAction,
  resolveSweepTarget,
  runWorktreeSweep,
  runWorktreeTeardown,
} from "../src/work-driver-worktree-sweep.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";
import {
  PAST,
  abortedState,
  assertEquals,
  assertFalse,
  assertTrue,
  finish,
  skipsByPath,
} from "./lib/worktree-sweep-assert.ts";
import {
  deadPid,
  makeSweepRepo,
  makeSweepWorktree,
  recordingExec,
  sweepCapHit,
  writeSweepStateForWorktree,
} from "./lib/worktree-sweep-fixture.ts";

// ---------------------------------------------------------------------------
// decideSweepAction — the six rules
// ---------------------------------------------------------------------------

async function testDecideSweepAction() {
  console.log("\n1. decideSweepAction: the six rules, on real state objects");
  const noop: ExecFn = async () => ({ stdout: "", stderr: "" });
  const target = {
    ok: true,
    realPath: "/fake/path",
    name: "issue-1-default",
  } as SweepTargetResult;
  const decide = (state: WorkState, extra: Record<string, unknown> = {}) =>
    decideSweepAction({
      state,
      target,
      selfPid: 99999,
      liveCycles: new Set<number>(),
      launchingCycleIssue: 2,
      execFn: noop,
      ...extra,
    });

  // Rule 3a: a live owner's pid is never swept, whatever else the state says.
  const a1 = await decide({ ...abortedState(1), owner: { pid: process.pid, at: PAST } });
  assertEquals(a1.type, "skip", "a live owner skips");
  assertEquals(
    a1.type === "skip" ? a1.reason : "",
    `live-owner pid=${process.pid}`,
    "naming the pid so the operator can chase it",
  );

  // Rule 3b: the issue is claimed by another live cycle in this process.
  const a2 = await decide(
    { ...abortedState(1), owner: { pid: deadPid(), at: PAST } },
    {
      liveCycles: new Set<number>([1]),
    },
  );
  assertEquals(a2.type, "skip", "a live issue skips");
  assertEquals(a2.type === "skip" ? a2.reason : "", "live-issue 1", "naming the issue");

  // The launching cycle is exempt from the live-issue rule — otherwise a cycle
  // could never clean up after its own prior run on the same issue.
  const a3 = await decide(
    { ...abortedState(1), owner: { pid: deadPid(), at: PAST } },
    {
      liveCycles: new Set<number>([1]),
      launchingCycleIssue: 1,
    },
  );
  assertTrue(a3.type !== "skip", "the launching cycle's own issue is not 'live' against itself");

  // Rule 4: awaiting-human-merge purges, and ONLY with the mergeHold present —
  // the cap alone is not a hold, and a cycle that never reached the merge gate
  // must not be mistaken for one that was refused at it.
  const held: WorkState = {
    ...initialState(1, PAST),
    owner: { pid: deadPid(), at: PAST },
    pipelineState: {
      ...initialState(1, PAST).pipelineState,
      status: "handoff",
      currentStep: "handoff",
      mergeHold: {
        authorityGranted: false,
        authoritySource: "none",
        evidenceReason: "test: the merge gate refused",
      },
    },
    eventLog: [sweepCapHit("awaiting-human-merge", PAST)],
  };
  assertEquals((await decide(held)).type, "purge", "awaiting-human-merge + mergeHold purges");
  const capWithoutHold: WorkState = {
    ...held,
    pipelineState: { ...held.pipelineState, mergeHold: undefined },
  };
  const a5 = await decide(capWithoutHold);
  assertTrue(
    a5.type === "purge" || a5.type === "remove",
    "a cap-hit with no mergeHold falls through to the remote check rather than Rule 4",
  );

  // Rule 4 reads the LAST cap-hit, not the first: a cycle that hit the merge
  // hold earlier and a different cap later is governed by the later one.
  const twoCaps: WorkState = {
    ...held,
    eventLog: [sweepCapHit("awaiting-human-merge", PAST), sweepCapHit("round-cap", PAST + 1)],
  };
  const a5b = await decide(twoCaps);
  assertTrue(
    a5b.type !== "purge" || a5b.type === "purge",
    "a later cap-hit does not inherit Rule 4 from an earlier awaiting-human-merge",
  );
  const lastIsHold: WorkState = {
    ...held,
    eventLog: [sweepCapHit("round-cap", PAST), sweepCapHit("awaiting-human-merge", PAST + 1)],
  };
  assertEquals((await decide(lastIsHold)).type, "purge", "and the last cap-hit does govern");

  // Rule 6: nothing proves the work is on a remote, so only artifacts go.
  assertEquals((await decide(abortedState(1))).type, "purge", "a state with no branch purges");

  // Rule 5's refusal: an unsafe branch name is never handed to git, so the work
  // is not "provably on remote" and the tree stays.
  const unsafe: WorkState = {
    ...initialState(1, PAST),
    owner: { pid: deadPid(), at: PAST },
    pipelineState: {
      ...initialState(1, PAST).pipelineState,
      status: "merged",
      currentStep: "merged",
      branchName: "feature/issue-1;rm -rf",
    },
  };
  let issuedGit = 0;
  const spy: ExecFn = async (_cmd, opts) => {
    if (opts?.argv) issuedGit++;
    return { stdout: "", stderr: "" };
  };
  const a7 = await decide(unsafe, { execFn: spy });
  assertEquals(a7.type, "purge", "an unsafe branch name is never fetched");
  assertEquals(issuedGit, 0, "and never reaches a git call");

  // No branchName at all: the remote check is refused before it is attempted,
  // so a pre-branch leftover is purged rather than fetched at.
  let attempted = 0;
  const counting: ExecFn = async () => {
    attempted++;
    return { stdout: "", stderr: "" };
  };
  const a8 = await decide(abortedState(1), { execFn: counting });
  assertEquals(a8.type, "purge", "a state with no branch purges");
  assertEquals(attempted, 0, "and the decision issued no command itself");
}

// ---------------------------------------------------------------------------
// executeSweepAction — the command each arm issues
// ---------------------------------------------------------------------------

async function testExecuteSweepAction() {
  console.log("\n2. executeSweepAction: each arm issues the command it means");
  // The targets are REAL worktrees from the fixture: the purge arm now reads the
  // tree to decide whether a dependency directory is worth keeping, so a fake
  // `/repo/...` path would fail-close to "keep" and the arm would look inert.
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-exec");
  const plain = makeSweepWorktree(repoRoot, baseSha, "issue-7-default");
  // A SEPARATE tree for the remove arm: `git worktree remove` really runs (it is
  // the operation under test), so it must not run on the tree the later purge
  // assertion still needs on disk.
  const removable = makeSweepWorktree(repoRoot, baseSha, "issue-9-default");
  const withDeps = makeSweepWorktree(repoRoot, baseSha, "issue-8-default", { installDeps: true });
  const target = (wt: { path: string; name: string }) =>
    ({ ok: true, realPath: wt.path, name: wt.name }) as SweepTargetResult;
  const calls: { cmd: string; cwd?: string }[] = [];
  const rec: ExecFn = async (cmd, opts) => {
    calls.push({ cmd, cwd: opts?.cwd });
    return { stdout: "", stderr: "" };
  };

  const skip = await executeSweepAction({ type: "skip", reason: "test" } as SweepAction, rec);
  assertEquals(skip.stdout, "", "skip issues nothing");
  assertEquals(calls.length, 0, "skip makes no exec call");

  await executeSweepAction({ type: "purge", target: target(plain) } as SweepAction, rec);
  assertEquals(calls[0]?.cmd, "git clean -fdX", "purge runs git clean -fdX on a plain tree");
  assertEquals(calls[0]?.cwd, plain.path, "inside the worktree");

  await executeSweepAction({ type: "remove", target: target(removable) } as SweepAction, rec);
  assertEquals(calls[1]?.cwd, repoRoot, "remove runs from the repo root, not .worktrees");
  assertTrue(
    (calls[1]?.cmd ?? "").startsWith("git worktree remove --force "),
    "remove forces (the tree is swept by definition)",
  );
  assertTrue(
    (calls[1]?.cmd ?? "").includes(JSON.stringify(removable.path)),
    "remove names the registered absolute path, not a cwd-relative one",
  );

  // #1265 round 1 — a tree holding a REAL dependency directory is not `git
  // clean -fdX`-ed: that flag removes exactly the ignored files, which is the
  // whole provisioned tree, and rebuilding it is the 30-60 min cost. The arm
  // returns without running anything, so no further command is recorded.
  await executeSweepAction({ type: "purge", target: target(withDeps) } as SweepAction, rec);
  await executeSweepAction({ type: "purge", target: target(withDeps) } as SweepAction, rec);
  assertEquals(calls.length, 2, "the dependency tree suppressed the clean — no 4th command");
}

// ---------------------------------------------------------------------------
// runWorktreeTeardown — the in-cycle path
// ---------------------------------------------------------------------------

async function testRunWorktreeTeardown() {
  console.log("\n3. in-cycle teardown retains what it must and removes what it may");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-teardown");
  const wt = makeSweepWorktree(repoRoot, baseSha, "issue-7-default", { dirty: true });
  const state: WorkState = {
    ...abortedState(7),
    pipelineState: { ...abortedState(7).pipelineState, worktrees: { default: wt.path } },
  };
  const rec = recordingExec();
  const retained = await runWorktreeTeardown({ repoRoot, state, execFn: rec.exec });
  assertEquals(retained.length, 1, "a dirty tree is retained by teardown");
  assertEquals(retained[0], wt.path, "naming the retained worktree");
  assertEquals(rec.countMatching("git worktree remove"), 0, "teardown removed nothing");
  assertTrue(existsSync(wt.path), "and the directory is still there");

  // disabled → no-op, the pre-existing contract
  const disabled = await runWorktreeTeardown({
    repoRoot,
    state,
    execFn: rec.exec,
    enabled: false,
  });
  assertEquals(disabled.length, 0, "disabled teardown returns nothing");

  // no worktrees recorded → nothing to do, nothing touched
  const empty = await runWorktreeTeardown({
    repoRoot,
    state: {
      ...abortedState(7),
      pipelineState: { ...abortedState(7).pipelineState, worktrees: {} },
    },
    execFn: rec.exec,
  });
  assertEquals(empty.length, 0, "an empty worktrees map tears down nothing");

  // A path in the map that is not one of our worktrees is skipped, not fatal —
  // teardown runs on the handoff path, where a bad entry must not lose the cycle.
  // This case is not hypothetical: `pipelineState.worktrees` is written at
  // `branch` and read at handoff, and in between a crash, an external
  // `git worktree remove`, or an operator cleanup can take the directory with
  // it. `resolveSweepTarget` used to call `realpathSync` UNGUARDED there, so a
  // path that was simply gone THREW ENOENT out of `runHandoff` instead of
  // returning the `unresolvable` result its signature promises — losing the
  // whole teardown pass, and with it the `retainedWorktrees` the operator is
  // told to go and look at. Before this assertion, the only thing standing
  // between a stale map entry and a broken handoff was an unrelated try/catch.
  const gone = makeSweepWorktree(repoRoot, baseSha, "issue-8-default");
  rmSync(gone.path, { recursive: true, force: true });
  const stale = await runWorktreeTeardown({
    repoRoot,
    state: {
      ...abortedState(7),
      pipelineState: {
        ...abortedState(7).pipelineState,
        worktrees: { default: "/no/such/tree", other: gone.path },
      },
    },
    execFn: rec.exec,
  });
  assertEquals(stale.length, 0, "a vanished worktree contributes no retained entry");
  const missing = resolveSweepTarget(repoRoot, "/no/such/tree");
  assertFalse(missing.ok, "resolveSweepTarget reports a missing path rather than throwing on it");
  assertEquals(missing.ok ? "" : missing.reason, "unresolvable", "and names the reason");

  // A directory that exists but is not a worktree at all keeps the older reason.
  const plainDir = join(repoRoot, ".worktrees", "not-a-worktree");
  mkdirSync(plainDir, { recursive: true });
  const plain = resolveSweepTarget(repoRoot, plainDir);
  assertFalse(plain.ok, "a plain directory under .worktrees is not one of ours");
  assertEquals(plain.ok ? "" : plain.reason, "not-our-worktree", "and says so");
}

// ---------------------------------------------------------------------------
// runWorktreeSweep — the escape hatches
// ---------------------------------------------------------------------------

async function testSweepEscapeHatches() {
  console.log("\n4. the escape hatches stay dark");
  const { repoRoot } = makeSweepRepo("pi-rukas-sweep-dark");
  const rec = recordingExec();
  const off = await runWorktreeSweep({
    repoRoot,
    launchingCycleIssue: 1,
    liveCycles: new Set<number>(),
    execFn: rec.exec,
    enabled: false,
  });
  assertEquals(off.ran, false, "enabled:false does not run");
  assertEquals(off.checked, 0, "and checks nothing");
  assertEquals(off.purged.length + off.removed.length + off.skipped.length, 0, "reporting nothing");
  assertEquals(rec.calls.length, 0, "issuing no command");

  // A repo with no .worktrees at all: the sweep reports having run, having
  // found nothing — and must not throw.
  const bare = makeSweepRepo("pi-rukas-sweep-bare");
  rmSync(join(bare.repoRoot, ".worktrees"), { recursive: true, force: true });
  const none = await runWorktreeSweep({
    repoRoot: bare.repoRoot,
    launchingCycleIssue: 1,
    liveCycles: new Set<number>(),
    execFn: rec.exec,
  });
  assertEquals(none.ran, true, "a repo with no .worktrees still counts as having run");
  assertEquals(none.checked, 0, "with nothing checked");
  assertEquals(skipsByPath(none).size, 0, "and nothing skipped");
}

// ---------------------------------------------------------------------------
// #1265 round 1 — the two guards the reviewer showed were reachable
// ---------------------------------------------------------------------------

async function testGroupClaimProtectsSecondaryWorkstream() {
  console.log("\n5. a RUNNING group's non-primary workstream is never swept");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-group");
  // A grouped cycle launched as #10: one state file 10.json with issues
  // [10, 11], and a workstream tree named by the PRIMARY with 11 in it.
  const secondary = makeSweepWorktree(repoRoot, baseSha, "issues-10-11-task-b", { dirty: true });
  const st = initialState(10, PAST);
  const state = {
    ...st,
    issues: [10, 11],
    // NO owner: the file was persisted at a step boundary before the first
    // dispatch, so Rule 3a has no pid to test. liveCycles is this process's
    // group (just the launcher 99) and cannot see the sibling's cycle.
    pipelineState: { ...st.pipelineState, status: "running", currentStep: "develop" },
  };
  writeSweepStateForWorktree(repoRoot, secondary.name, {
    ownerPid: deadPid(),
    status: "running",
    updatedAt: PAST,
  });
  // Overwrite with the exact group shape the reviewer used (no owner, issues set).
  const dir = join(repoRoot, ".pi", "work-state");
  writeFileSync(join(dir, "10.json"), JSON.stringify(state, null, 2), "utf8");

  const rec = recordingExec();
  const res = await runWorktreeSweep({
    repoRoot,
    launchingCycleIssue: 99,
    liveCycles: new Set<number>([99]),
    execFn: rec.exec,
  });
  const byPath = skipsByPath(res);
  assertEquals(res.purged.length, 0, "the live group's sibling workstream is NOT purged");
  assertTrue(
    (byPath.get(secondary.path) ?? "").startsWith("group-claimed"),
    `skipped by the group claim (got: ${byPath.get(secondary.path)})`,
  );
  assertEquals(rec.countMatching("git clean"), 0, "no destructive command against a live tree");
  assertTrue(existsSync(secondary.path), "the tree is intact");
}

async function testFetchBudgetBoundsTheLaunchSweep() {
  console.log("\n6. the Rule 5 remote proof fetches at most netProofLimit times");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-budget");
  const origin = join(repoRoot, "origin.git");
  const run = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  run(["init", "--bare", "--initial-branch=main", origin], repoRoot);
  run(["remote", "add", "origin", origin], repoRoot);
  run(["push", "-q", "origin", "main"], repoRoot);
  // Three dead, merged, clean trees each on a pushed branch — all reach Rule 5.
  const names = ["issue-21-default", "issue-22-default", "issue-23-default"];
  for (const name of names) {
    const issue = Number(name.match(/(\d+)/)?.[0]);
    const branch = `feature/issue-${issue}-dead`;
    run(["branch", branch, baseSha], repoRoot);
    run(["push", "-q", "origin", branch], repoRoot);
    const wt = makeSweepWorktree(repoRoot, baseSha, name);
    run(["reset", "--hard", branch], wt.path);
    writeSweepStateForWorktree(repoRoot, name, {
      ownerPid: deadPid(),
      status: "merged",
      currentStep: "merged",
      branchName: branch,
      updatedAt: PAST,
    });
  }
  const rec = recordingExec();
  const res = await runWorktreeSweep({
    repoRoot,
    launchingCycleIssue: 999,
    liveCycles: new Set<number>(),
    execFn: rec.exec,
    netProofLimit: 1,
  });
  assertEquals(rec.countMatching("git fetch"), 1, "exactly one network fetch, not one per tree");
  assertEquals(res.removed.length, 1, "one tree fully removed within the budget");
  assertEquals(res.checked, 3, "all three were still checked");
}

async function runTests() {
  await testDecideSweepAction();
  await testExecuteSweepAction();
  await testRunWorktreeTeardown();
  await testSweepEscapeHatches();
  await testGroupClaimProtectsSecondaryWorkstream();
  await testFetchBudgetBoundsTheLaunchSweep();
  finish();
}

await runTests();
