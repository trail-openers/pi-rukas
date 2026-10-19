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
 *
 * The in-cycle `runWorktreeTeardown` pass that used to sit in this file moved
 * to `test-worktree-teardown-retention.ts` when the #1265 assertions pushed
 * this file past §12's cap: no case was deleted, and both files exit through
 * the shared `finish()` in `lib/worktree-sweep-assert.ts`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PACKAGE_DIR_MARKERS,
  PROVISIONED_DEP_NAMES,
  type SweepTargetResult,
  decideSweepAction,
  executeSweepAction,
  hasRealDependencyTree,
  runWorktreeSweep,
} from "../src/work-driver-worktree-sweep.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
import { SHAREABLE_DEPS } from "../src/worktree-dep-contract.ts";
import { DEPENDENCY_MARKERS } from "../src/worktree-provision-hook.ts";
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
  const a1 = await decide({
    ...abortedState(1),
    owner: { pid: process.pid, at: PAST },
  });
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
  // The concrete arm, not a disjunction: Rule 4 does not fire (no mergeHold) and
  // `decide()` runs with no `netProofBudget`, so Rule 5 cannot fire either — the
  // only answer the rule engine can give is Rule 6's artifact purge. An
  // `"purge" || "remove"` assertion here accepted either verdict and therefore
  // could not notice Rule 5 starting to fire on an unproven tree.
  assertEquals(
    a5.type,
    "purge",
    "a cap-hit with no mergeHold is NOT a Rule 4 hold, and falls through to the purge",
  );

  // Rule 4 reads the LAST cap-hit, not the first: a cycle that hit the merge
  // hold earlier and a different cap later is governed by the later one.
  const twoCaps: WorkState = {
    ...held,
    eventLog: [sweepCapHit("awaiting-human-merge", PAST), sweepCapHit("round-cap", PAST + 1)],
  };
  const a5b = await decide(twoCaps);
  // Same reasoning as `a5` above, and the reason a disjunction here was worth
  // nothing: `a5b.type !== "purge" || a5b.type === "purge"` is true for every
  // possible value, so it asserted nothing about Rule 4's last-cap-hit rule.
  // With the later cap (`round-cap`) governing, Rule 4 does not fire and the
  // answer is Rule 6's purge.
  assertEquals(
    a5b.type,
    "purge",
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
  const withDeps = makeSweepWorktree(repoRoot, baseSha, "issue-8-default", {
    installDeps: true,
  });
  const target = (wt: { path: string; name: string }): SweepTargetResult => ({
    ok: true,
    realPath: wt.path,
    name: wt.name,
  });
  const calls: { cmd: string; cwd?: string }[] = [];
  const rec: ExecFn = async (cmd, opts) => {
    calls.push({ cmd, cwd: opts?.cwd });
    return { stdout: "", stderr: "" };
  };

  const skip = await executeSweepAction({ type: "skip", reason: "test" }, rec);
  assertEquals(skip.stdout, "", "skip issues nothing");
  assertEquals(calls.length, 0, "skip makes no exec call");

  const plainPurge = await executeSweepAction({ type: "purge", target: target(plain) }, rec);
  assertEquals(plainPurge.purgeSkipped, undefined, "a plain tree's purge actually ran");
  assertEquals(calls[0]?.cmd, "git clean -fdX", "purge runs git clean -fdX on a plain tree");
  assertEquals(calls[0]?.cwd, plain.path, "inside the worktree");

  await executeSweepAction({ type: "remove", target: target(removable) }, rec);
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
  // returns without running anything, and says so: `purgeSkipped` is the field
  // that keeps a caller's `purged` list honest (#1265 lens FIX 4).
  const suppressed = await executeSweepAction({ type: "purge", target: target(withDeps) }, rec);
  assertEquals(suppressed.purgeSkipped, true, "the suppressed purge reports itself");
  await executeSweepAction({ type: "purge", target: target(withDeps) }, rec);
  assertEquals(calls.length, 2, "the dependency tree suppressed the clean — no 4th command");

  // #1265 lens FIX 2 — the guard reads depth-1 PACKAGE directories too. pi-rukas's
  // own real tree lives at `extension/node_modules`; a root-only scan read its
  // absence as "nothing worth keeping" and cleaned a 30-60 minute install.
  const nested = makeSweepWorktree(repoRoot, baseSha, "issue-11-default", {
    installNestedDeps: true,
  });
  const nestedPurge = await executeSweepAction({ type: "purge", target: target(nested) }, rec);
  assertEquals(nestedPurge.purgeSkipped, true, "a nested package dir's tree suppresses the purge");
  assertEquals(calls.length, 2, "and it issued no command");

  // #1265 lens FIX 2b — a BROKEN symlink is not a real tree. The pre-fix shape
  // asked `isSymbolicLink()` of a stat the fs had already followed (always
  // false) and `isDirectory()` of the same (false for a dangling link), which
  // protected exactly the case with nothing to protect.
  const dangling = makeSweepWorktree(repoRoot, baseSha, "issue-12-default");
  symlinkSync(join(dangling.path, "nowhere"), join(dangling.path, "node_modules"));
  assertFalse(hasRealDependencyTree(dangling.path), "a dangling node_modules is not a real tree");
  const danglingPurge = await executeSweepAction({ type: "purge", target: target(dangling) }, rec);
  assertEquals(danglingPurge.purgeSkipped, undefined, "so the clean runs anyway");
  assertEquals(calls.length, 3, "and the arm issued its git clean");

  // A symlink to a REAL tree is the other half: following it would have read a
  // link as an install. It is not one — the provisioner's own links are free to
  // drop and re-make.
  const linked = makeSweepWorktree(repoRoot, baseSha, "issue-13-default");
  symlinkSync(join(withDeps.path, "node_modules"), join(linked.path, "node_modules"));
  assertFalse(hasRealDependencyTree(linked.path), "a symlink to a real tree is still a symlink");

  // The names the guard protects are the provisioner's, not a copy of them.
  // FIX 1: a stale local list would silently stop suppressing the purge the day
  // `SHAREABLE_DEPS` gained a member — and the copy would keep passing.
  assertEquals(
    PROVISIONED_DEP_NAMES.join(","),
    SHAREABLE_DEPS.join(","),
    "the sweep's dependency names ARE worktree-provision.ts's SHAREABLE_DEPS",
  );
  assertEquals(
    PACKAGE_DIR_MARKERS.join(","),
    DEPENDENCY_MARKERS.join(","),
    "and its package markers ARE worktree-provision-hook.ts's DEPENDENCY_MARKERS",
  );
}

// ---------------------------------------------------------------------------
// runWorktreeSweep — the escape hatches
// ---------------------------------------------------------------------------

async function testSweepEscapeHatches() {
  console.log("\n3. the escape hatches stay dark");
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
  console.log("\n4. a RUNNING group's non-primary workstream is never swept");
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
    pipelineState: {
      ...st.pipelineState,
      status: "running",
      currentStep: "develop",
      worktrees: { task: secondary.path },
    },
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
  console.log("\n5. the Rule 5 remote proof fetches at most netProofLimit times");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-budget");
  const origin = join(repoRoot, "origin.git");
  const run = (args: string[], cwd: string) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
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
  await testSweepEscapeHatches();
  await testGroupClaimProtectsSecondaryWorkstream();
  await testFetchBudgetBoundsTheLaunchSweep();
  finish();
}

await runTests();
