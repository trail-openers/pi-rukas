#!/usr/bin/env bun
/**
 * #1265 — the launch worktree sweep, end-to-end, on real git.
 *
 * Until this file was rewritten, every assertion about the sweep was about a
 * sweep that had already been switched off: the one `runWorktreeSweep` case
 * passed `enabled: false`, so the loop that reads state files and the decision
 * engine behind it had no test at all. Production measured 47 candidates, 0
 * actions, 47 `state-unreadable` skips and **zero git calls** — the sweep had
 * been dark through three source commits precisely because the only thing the
 * suite proved about it was that returning early returns early.
 *
 * So every case here lays down a REAL `git worktree add` and a REAL state file
 * in a REAL repo, and asserts on the recorded command transcript rather than
 * only on the returned lists: a sweep that decides to act and then issues
 * nothing must fail here, and so must one that issues a command into a tree
 * that is not a leftover. Three regressions, each individually invisible:
 *
 *  1. the state-file lookup (`issue-<N>-<id>` directory → `<N>.json` file);
 *  2. the own-tree guard (the launching cycle's tree is never touched);
 *  3. the removal arm actually removing (cwd + path shape git accepts).
 *
 * Cases 1–3 pin the name→state-file rule itself, which is where the bug lived;
 * 4–9 pin what the sweep does once it CAN read a state file. The decision
 * engine's rules and the command each arm issues are covered by
 * `test-work-driver-worktree-sweep-rules.ts` (the §12 500-line cap split the
 * coverage at the real-git / no-git seam, which is also the seam between
 * "the sweep's verdict becomes a real command" and "the verdict was right").
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../src/work-driver-resume.ts";
import {
  isLaunchingCycleOwnWorktree,
  parseWorktreeIssue,
  resolveSweepTarget,
  runWorktreeSweep,
} from "../src/work-driver-worktree-sweep.ts";
import {
  PAST,
  abortedState,
  assertEquals,
  assertFalse,
  assertTrue,
  failFast,
  finish,
  skipReasons,
  skipsByPath,
} from "./lib/worktree-sweep-assert.ts";
import {
  deadPid,
  makeSweepRepo,
  makeSweepWorktree,
  readWorktreeGitdir,
  recordingExec,
  sweepGitdirLine,
  writeSweepStateForWorktree,
} from "./lib/worktree-sweep-fixture.ts";

function testParseWorktreeIssue() {
  console.log("\n1. parseWorktreeIssue: the shape the sweep resolves a state file from");
  // The shapes work-driver-branch-mechanized.ts actually writes.
  assertEquals(parseWorktreeIssue("issue-7-default"), 7, "issue-<N>-<id> resolves to N");
  assertEquals(parseWorktreeIssue("issue-1006-task-a"), 1006, "multi-digit issue resolves");
  assertEquals(
    parseWorktreeIssue("issue-1265-integrate"),
    1265,
    "the driver-owned integrate tree resolves to its cycle's issue",
  );
  assertEquals(
    parseWorktreeIssue("issues-10-11-task-b"),
    10,
    "a grouped tree resolves to the PRIMARY issue (the state file's key)",
  );
  // Not worktrees: the sweep must not invent a state file for these.
  assertEquals(parseWorktreeIssue("7-default"), undefined, "the issue- prefix is required");
  assertEquals(parseWorktreeIssue("issue-default"), undefined, "no number is no issue");
  assertEquals(parseWorktreeIssue("issue-0-default"), undefined, "issue 0 is not a real issue");
  assertEquals(parseWorktreeIssue("prefix-issue-7-x"), undefined, "the prefix must lead");
  assertEquals(parseWorktreeIssue("issue-7"), undefined, "a trailing separator is required");
  // The regression this exists for: a basename is NOT a state file name, and
  // reading `<basename>.json` is the bug. If anyone restores that lookup by
  // "fixing" the parser to accept it, this fails.
  assertEquals(
    parseWorktreeIssue("issue-7-default.json"),
    7,
    "even a name ending .json resolves by its issue prefix, never by basename",
  );
}

function testIsLaunchingCycleOwnWorktree() {
  console.log("\n2. isLaunchingCycleOwnWorktree: the self-guard that never matched");
  // The pre-fix comparison was `name === `${issue}-default``. Every one of
  // these is a tree the launching cycle owns and must never sweep.
  assertTrue(isLaunchingCycleOwnWorktree("issue-1006-default", 1006), "own default tree");
  assertTrue(isLaunchingCycleOwnWorktree("issue-1006-task-a", 1006), "own named workstream tree");
  assertTrue(isLaunchingCycleOwnWorktree("issue-1006-integrate", 1006), "own integrate tree");
  assertTrue(
    isLaunchingCycleOwnWorktree("issues-10-11-task-a", 10),
    "own tree of a grouped cycle whose primary is the launcher",
  );
  // A sibling on a different issue is fair game.
  assertFalse(
    isLaunchingCycleOwnWorktree("issue-1007-default", 1006),
    "another issue's tree is not the launcher's own",
  );
  // A tree that names no issue is not the launcher's either — it gets the
  // `name-has-no-issue` skip, not a false sense of ownership.
  assertFalse(
    isLaunchingCycleOwnWorktree("stray-directory", 1006),
    "an unparseable name is not the launcher's own",
  );
  // The shape the old guard accepted and must never accept again: it matched a
  // name no worktree has, which is why it never fired.
  assertFalse(
    isLaunchingCycleOwnWorktree("1006-default", 1006),
    "the old `${issue}-default` shape is not a worktree and is not owned",
  );
}

async function testStateFileLookupIsNotTheBasename() {
  console.log("\n3. the state file lives at <N>.json, not <basename>.json");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-lookup");
  const wt = makeSweepWorktree(repoRoot, baseSha, "issue-7-default");
  // The `.git` file the sweep's exact-string check reads, and what the
  // fixture's producer wrote, are the same line — if git ever changes the
  // layout this fails instead of quietly skipping every candidate.
  assertEquals(
    readWorktreeGitdir(wt.path),
    wt.expectedGitdir,
    "the .git file matches what resolveSweepTarget expects",
  );
  assertEquals(
    readWorktreeGitdir(wt.path),
    sweepGitdirLine(repoRoot, "issue-7-default"),
    "and matches the shared line builder",
  );
  assertTrue(resolveSweepTarget(repoRoot, wt.path).ok, "so the candidate resolves");

  // Write the state file where the BROKEN sweep looked. Then assert the real
  // sweep still reports it unreadable — which is only observable because the
  // correct file does not exist.
  const stateDir = join(repoRoot, ".pi", "work-state");
  writeFileSync(
    join(stateDir, "issue-7-default.json"),
    JSON.stringify({ ...abortedState(7), issue: 7 }, null, 2),
    "utf8",
  );
  const rec = recordingExec();
  const res = await runWorktreeSweep({
    repoRoot,
    launchingCycleIssue: 999,
    liveCycles: new Set<number>(),
    execFn: rec.exec,
  });
  assertEquals(res.checked, 1, "the candidate was checked");
  assertEquals(res.skipped[0]?.reason, "state-unreadable", "the basename file is not consulted");
  assertEquals(rec.calls.length, 0, "an unreadable state issues no git call at all");
}

// ---------------------------------------------------------------------------
// 4–9: what the sweep does once it can read a state file
// ---------------------------------------------------------------------------

async function testSweepPurgesDeadOwnersLeftover() {
  console.log("\n4. end-to-end: a killed cycle's dirty leftover is PURGED (the issue's DoD)");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-purge");
  const wt = makeSweepWorktree(repoRoot, baseSha, "issue-7-default", { dirty: true });
  writeSweepStateForWorktree(repoRoot, wt.name, {
    ownerPid: deadPid(),
    status: "aborted",
    currentStep: "develop",
    updatedAt: PAST,
  });

  const rec = recordingExec();
  const res = await runWorktreeSweep({
    repoRoot,
    launchingCycleIssue: 1006,
    liveCycles: new Set<number>(),
    execFn: rec.exec,
  });

  assertEquals(res.ran, true, "the sweep ran");
  assertEquals(res.checked, 1, "the leftover was checked, not skipped as not-our-worktree");
  assertEquals(res.purged.length, 1, "one worktree purged");
  assertEquals(res.purged[0], wt.path, "purged path is the worktree");
  assertEquals(res.removed.length, 0, "a dirty tree is never fully removed");
  assertEquals(res.skipped.length, 0, `nothing skipped (got: ${skipReasons(res)})`);
  // The transcript is the load-bearing assertion: a `purged` list without a
  // command behind it is the #1265 failure mode wearing a different hat.
  assertEquals(rec.countMatching("git clean -fdX"), 1, "git clean -fdX was actually issued");
  assertTrue(existsSync(wt.path), "a purge keeps the directory (artifacts only)");
}

async function testSweepRemovesWorkOnRemote() {
  console.log("\n5. end-to-end: a merged cycle's clean worktree is REMOVED for real");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-remove");
  const branch = "feature/issue-7-merged";
  // A real commit on a real branch pushed to a real origin: Rule 5 proves the
  // work is on the remote by fetching it, so "provably on remote" is git's
  // answer here, not a fake's.
  const run = (args: string[], cwd: string) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const origin = join(repoRoot, "origin.git");
  run(["init", "--bare", "--initial-branch=main", origin], repoRoot);
  run(["remote", "add", "origin", origin], repoRoot);
  run(["push", "-q", "origin", "main"], repoRoot);
  run(["branch", branch, baseSha], repoRoot);
  run(["push", "-q", "origin", branch], repoRoot);

  const wt = makeSweepWorktree(repoRoot, baseSha, "issue-7-default");
  // HEAD sits exactly at the pushed branch tip and the tree is clean.
  run(["reset", "--hard", branch], wt.path);
  writeSweepStateForWorktree(repoRoot, wt.name, {
    ownerPid: deadPid(),
    status: "merged",
    currentStep: "merged",
    branchName: branch,
    updatedAt: PAST,
  });

  const rec = recordingExec();
  const res = await runWorktreeSweep({
    repoRoot,
    launchingCycleIssue: 1006,
    liveCycles: new Set<number>(),
    execFn: rec.exec,
  });

  assertEquals(res.removed.length, 1, "one worktree removed");
  assertEquals(res.removed[0], wt.path, "removed path is the worktree");
  assertEquals(res.purged.length, 0, "a provably-pushed tree is removed, not merely purged");
  assertEquals(res.skipped.length, 0, `nothing skipped (got: ${skipReasons(res)})`);
  const cmds = rec.commands();
  assertTrue(
    cmds.some((c) => c.includes("git fetch origin") && c.includes(branch)),
    `the remote proof fetched the branch (got: ${cmds.join(" | ")})`,
  );
  assertEquals(rec.countMatching("git worktree remove --force"), 1, "the removal ran");
  // The removal runs from the repo root with the registered path. From
  // `.worktrees/` with a relative path it was cwd-dependent; this pins the shape.
  const removeCall = rec.calls.find((c) => c.cmd.includes("git worktree remove"));
  assertEquals(removeCall?.cwd, repoRoot, "the removal ran with cwd = repoRoot");
  assertTrue(
    (removeCall?.cmd ?? "").includes(JSON.stringify(wt.path)),
    "the removal named the worktree's absolute path",
  );
  assertFalse(existsSync(wt.path), "the directory is gone — git really removed it");
}

async function testSweepSkipsLiveOwnerAndLiveIssue() {
  console.log("\n6. a live owner or a live sibling issue is never touched");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-live");
  const mine = makeSweepWorktree(repoRoot, baseSha, "issue-7-default", { dirty: true });
  const theirs = makeSweepWorktree(repoRoot, baseSha, "issue-8-default", { dirty: true });
  const stranger = makeSweepWorktree(repoRoot, baseSha, "issue-9-default", { dirty: true });
  // `selfPid` is the sweep's own process, so the owner pid must differ from it
  // for Rule 3a to fire at all — that is the self-exemption, not an oversight.
  // A detached child parked on a stdin read is the honest way to hold a pid
  // this test can reap, rather than a number that happens to be free.
  const parked = spawn("cat", [], { detached: true, stdio: ["ignore", "ignore", "ignore"] });
  parked.unref();
  const liveOtherPid = parked.pid;
  if (liveOtherPid === undefined || !processAlive(liveOtherPid)) {
    failFast("could not park a live child to own a state file — case 6 cannot run");
  }
  try {
    writeSweepStateForWorktree(repoRoot, mine.name, {
      ownerPid: liveOtherPid,
      status: "aborted",
      updatedAt: PAST,
    });
    writeSweepStateForWorktree(repoRoot, theirs.name, {
      ownerPid: deadPid(),
      status: "aborted",
      updatedAt: PAST,
    });
    writeSweepStateForWorktree(repoRoot, stranger.name, {
      ownerPid: deadPid(),
      status: "aborted",
      updatedAt: PAST,
    });

    const rec = recordingExec();
    const res = await runWorktreeSweep({
      repoRoot,
      launchingCycleIssue: 1006,
      liveCycles: new Set<number>([8]),
      execFn: rec.exec,
    });
    assertEquals(res.purged.length, 1, "only the dead, unclaimed tree was swept");
    assertEquals(res.purged[0], stranger.path, "and it is the one with no owner and no claim");
    const byPath = skipsByPath(res);
    assertTrue(
      (byPath.get(mine.path) ?? "").startsWith("live-owner"),
      `live owner skipped by pid (got: ${byPath.get(mine.path)})`,
    );
    assertTrue(
      (byPath.get(mine.path) ?? "").includes(String(liveOtherPid)),
      "naming the owner pid the operator has to chase",
    );
    assertEquals(
      byPath.get(theirs.path),
      "live-issue 8",
      "a live sibling issue is skipped by issue",
    );
    assertEquals(
      rec.countMatching("git clean"),
      1,
      "exactly one cleanup command ran, for one tree",
    );
    for (const wt of [mine, theirs]) assertTrue(existsSync(wt.path), `${wt.name} survives`);
  } finally {
    try {
      process.kill(liveOtherPid, "SIGKILL");
    } catch {
      /* already reaped */
    }
  }
}

async function testSweepSkipsLaunchingCycleOwnTree() {
  console.log("\n7. the launching cycle's own tree is skipped (the guard that never fired)");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-own");
  const own = makeSweepWorktree(repoRoot, baseSha, "issue-1006-default", { dirty: true });
  const integrate = makeSweepWorktree(repoRoot, baseSha, "issue-1006-integrate", { dirty: true });
  const foreign = makeSweepWorktree(repoRoot, baseSha, "issue-11-default", { dirty: true });
  for (const wt of [own, integrate, foreign]) {
    writeSweepStateForWorktree(repoRoot, wt.name, {
      ownerPid: deadPid(),
      status: "aborted",
      updatedAt: PAST,
    });
  }

  const rec = recordingExec();
  const res = await runWorktreeSweep({
    repoRoot,
    launchingCycleIssue: 1006,
    liveCycles: new Set<number>([1006]),
    execFn: rec.exec,
  });

  const byPath = skipsByPath(res);
  assertEquals(byPath.get(own.path), "launching-cycle-own", "own default tree skipped by name");
  assertEquals(
    byPath.get(integrate.path),
    "launching-cycle-own",
    "own integrate tree skipped by name (pre-fix, its dead-owner state meant removal)",
  );
  assertEquals(res.purged.length, 1, "the foreign leftover was still swept");
  assertEquals(res.purged[0], foreign.path, "and it is the only one that was");
  assertTrue(existsSync(own.path), "the launching cycle's tree is intact");
  assertEquals(rec.countMatching("git clean -fdX"), 1, "exactly one cleanup command ran");
}

async function testSweepPurgesAwaitingHumanMerge() {
  console.log("\n8. an awaiting-human-merge park purges artifacts and keeps the tree");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-mergehold");
  const wt = makeSweepWorktree(repoRoot, baseSha, "issue-7-default", { dirty: true });
  writeSweepStateForWorktree(repoRoot, wt.name, {
    ownerPid: deadPid(),
    status: "handoff",
    currentStep: "handoff",
    branchName: "feature/issue-7-held",
    cap: "awaiting-human-merge",
    mergeHold: true,
    updatedAt: PAST,
  });

  const rec = recordingExec();
  const res = await runWorktreeSweep({
    repoRoot,
    launchingCycleIssue: 1006,
    liveCycles: new Set<number>(),
    execFn: rec.exec,
  });
  assertEquals(
    res.purged.length,
    1,
    "purged (artifacts), not removed (the operator still needs it)",
  );
  assertEquals(res.removed.length, 0, "a held merge is never removed");
  assertEquals(rec.countMatching("git worktree remove"), 0, "no removal command");
  assertTrue(existsSync(wt.path), "the tree survives for inspection");
}

async function testSweepSkipsUnreadableAndForeignCandidates() {
  console.log("\n9. unreadable state, foreign trees and anonymous dirs all SKIP and stay put");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-skips");

  // (a) a real worktree whose state file is missing entirely.
  const noState = makeSweepWorktree(repoRoot, baseSha, "issue-7-default");
  // (b) a real worktree whose state file is corrupt JSON.
  const corrupt = makeSweepWorktree(repoRoot, baseSha, "issue-8-default");
  writeFileSync(join(repoRoot, ".pi", "work-state", "8.json"), "{not json", "utf8");
  // (c) a real worktree whose state file belongs to ANOTHER issue: the file is
  // keyed by issue, so a stale file must not decide this tree's fate.
  const mismatched = makeSweepWorktree(repoRoot, baseSha, "issue-9-default");
  writeFileSync(
    join(repoRoot, ".pi", "work-state", "9.json"),
    JSON.stringify({ ...abortedState(4242), issue: 4242 }, null, 2),
    "utf8",
  );
  // (d) a directory under .worktrees that is not our worktree (foreign gitdir).
  const foreign = join(repoRoot, ".worktrees", "issue-12-default");
  mkdirSync(foreign, { recursive: true });
  writeFileSync(
    join(foreign, ".git"),
    "gitdir: /some/other/repo/.git/worktrees/issue-12-default\n",
  );
  // (e) one that is not a directory at all, and whose name does NOT look like a
  // worktree — which is what `readdirSync` + the directory filter are for
  // (work-driver-worktree-sweep.ts:322-325), the filter this fixture keeps honest.
  const looseFile = join(repoRoot, ".worktrees", "notes.txt");
  writeFileSync(looseFile, "x", "utf8");
  // (f) a real worktree whose name encodes no issue — no state file can exist for it.
  const anonymous = makeSweepWorktree(repoRoot, baseSha, "stray-tree");

  const rec = recordingExec();
  const res = await runWorktreeSweep({
    repoRoot,
    launchingCycleIssue: 1006,
    liveCycles: new Set<number>(),
    execFn: rec.exec,
  });

  const byPath = skipsByPath(res);
  assertEquals(byPath.get(noState.path), "state-unreadable", "missing state file skips");
  assertEquals(byPath.get(corrupt.path), "state-unreadable", "corrupt state file skips");
  assertTrue(
    (byPath.get(mismatched.path) ?? "").startsWith("state-issue-mismatch"),
    `state file naming another issue skips (got: ${byPath.get(mismatched.path)})`,
  );
  assertEquals(byPath.get(foreign), "not-our-worktree", "a foreign gitdir is not ours to sweep");
  assertEquals(
    byPath.get(anonymous.path),
    "name-has-no-issue",
    "an anonymous tree is kept, not guessed at",
  );
  // The directory filter drops a plain file before it is ever a candidate, so
  // it is neither swept NOR reported — and no assertion above can see it. Pin
  // that silence as the contract: `skipped` is only for things that looked like
  // worktrees, and `checked` never counts what the filter discarded.
  assertFalse(
    res.skipped.some((s) => s.path === looseFile),
    "the stray file never reaches the candidate list at all",
  );
  // Four candidates reach the decision engine. The fifth — the foreign gitdir —
  // is rejected by resolveSweepTarget and is reported without ever being
  // checked, which is the distinction this count pins: `checked` counts what
  // looked ours, not everything the sweep walked past.
  assertEquals(res.checked, 4, "four candidates resolved as ours (including the anonymous one)");
  assertEquals(res.purged.length + res.removed.length, 0, "nothing was swept");
  assertEquals(rec.calls.length, 0, "a sweep that skips issues no git call at all");
  for (const p of [noState.path, corrupt.path, mismatched.path, foreign, anonymous.path]) {
    assertTrue(existsSync(p), `${p.split("/").pop()} survives`);
  }
  // readdirSync order is what the sweep iterates, so prove the counts are the
  // sweep's view of the directory rather than this test's assumption about it.
  assertEquals(
    readdirSync(join(repoRoot, ".worktrees")).length,
    6,
    "the fixture laid down 6 entries",
  );
}

async function runTests() {
  testParseWorktreeIssue();
  testIsLaunchingCycleOwnWorktree();
  await testStateFileLookupIsNotTheBasename();
  await testSweepPurgesDeadOwnersLeftover();
  await testSweepRemovesWorkOnRemote();
  await testSweepSkipsLiveOwnerAndLiveIssue();
  await testSweepSkipsLaunchingCycleOwnTree();
  await testSweepPurgesAwaitingHumanMerge();
  await testSweepSkipsUnreadableAndForeignCandidates();
  finish();
}

await runTests();
