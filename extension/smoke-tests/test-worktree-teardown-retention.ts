#!/usr/bin/env bun
/**
 * #1265 — the cases the two sweep files could not hold under §12's 500-line cap.
 *
 * `src/work-driver-worktree-sweep.ts` is covered by three files, not two. The
 * split is by what each one runs, not by size alone:
 *
 * - `test-work-driver-worktree-sweep.ts` — the sweep end-to-end through REAL git.
 * - `test-work-driver-worktree-sweep-rules.ts` — the decision engine, no git.
 * - this file — the sweep cases that only ever SKIP (a live owner, a live
 *   sibling issue, the launching cycle's own tree), the two that check what the
 *   sweep REPORTS about an action it took, and the in-cycle teardown pass that
 *   never runs through `runWorktreeSweep` at all.
 *
 * Nothing here is new coverage: all three moved from the files named above, so
 * the §12 cap is met by relocation and not by deleting an assertion. Each file
 * exits through the shared `finish()` in `lib/worktree-sweep-assert.ts`, so the
 * three agree on what "failed" means.
 *
 * Why these three and not three shorter ones: they are the cases that fail
 * LOUDEST when the sweep lies about itself. A `purged` list with no command
 * behind it, a decision made from a state file this build never writes, and a
 * teardown that loses a handoff to an ENOENT are each invisible to the other two
 * files, and each was a real bug in the #1265 implementation.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processAlive } from "../src/work-driver-resume.ts";
import {
  resolveSweepTarget,
  runWorktreeSweep,
  runWorktreeTeardown,
} from "../src/work-driver-worktree-sweep.ts";
import type { WorkState } from "../src/workflow-state.ts";
import {
  PAST,
  abortedState,
  assertEquals,
  assertFalse,
  assertTrue,
  finish,
  foreignSchemaStateJson,
  skipsByPath,
} from "./lib/worktree-sweep-assert.ts";
import {
  deadPid,
  makeSweepRepo,
  makeSweepWorktree,
  recordingExec,
  writeSweepStateForWorktree,
} from "./lib/worktree-sweep-fixture.ts";

// ---------------------------------------------------------------------------
// What the sweep REPORTS about what it actually did
// ---------------------------------------------------------------------------

async function testSweepDoesNotClaimASuppressedPurge() {
  console.log("\n1. a purge the dependency guard suppressed is never reported as purged");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-purgeskip");
  // A dead, aborted, dirty leftover holding a REAL `node_modules`: Rule 6
  // decides `purge`, and the executor refuses to run `git clean -fdX` on it.
  const kept = makeSweepWorktree(repoRoot, baseSha, "issue-7-default", {
    dirty: true,
    installDeps: true,
  });
  writeSweepStateForWorktree(repoRoot, kept.name, {
    ownerPid: deadPid(),
    status: "aborted",
    updatedAt: PAST,
  });

  const rec = recordingExec();
  const res = await runWorktreeSweep({
    repoRoot,
    launchingCycleIssue: 1006,
    liveCycles: new Set<number>(),
    execFn: rec.exec,
  });
  // #1265 lens FIX 4 — the caller used to discard `SweepResult` and push every
  // `purge` decision into `purged`, so the operator's report claimed a clean of
  // a tree whose provisioned install was still sitting there.
  assertEquals(res.purged.length, 0, "a suppressed purge does NOT appear in `purged`");
  assertEquals(
    skipsByPath(res).get(kept.path),
    "purge-skipped:real-deps",
    "and appears in `skipped` with the reason the guard gave",
  );
  assertEquals(rec.countMatching("git clean"), 0, "no clean command was issued");
  assertTrue(existsSync(join(kept.path, "node_modules", "dep.js")), "the install is intact");
  assertEquals(res.checked, 1, "the tree WAS checked — this is a suppression, not a blind spot");
}

async function testSweepRefusesForeignSchemaState() {
  console.log("\n2. a state file from another driver version skips rather than decides");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-schema");
  // FIX 8: the sweep used to `JSON.parse(…) as WorkState`. An assertion is not a
  // check — a file written by a different build would have driven Rules 4–6 from
  // fields that mean something else there, and decided a tree's fate on them.
  const wt = makeSweepWorktree(repoRoot, baseSha, "issue-7-default", {
    dirty: true,
  });
  mkdirSync(join(repoRoot, ".pi", "work-state"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".pi", "work-state", "7.json"),
    foreignSchemaStateJson(7, 99),
    "utf8",
  );

  const rec = recordingExec();
  const res = await runWorktreeSweep({
    repoRoot,
    launchingCycleIssue: 1006,
    liveCycles: new Set<number>(),
    execFn: rec.exec,
  });
  assertEquals(
    skipsByPath(res).get(wt.path),
    "state-unreadable",
    "a foreign schemaVersion takes the same skip as corrupt JSON",
  );
  assertEquals(res.purged.length + res.removed.length, 0, "nothing was swept on it");
  assertEquals(rec.calls.length, 0, "and no command was issued");
  assertTrue(existsSync(wt.path), "the tree is left for the operator");
}

// ---------------------------------------------------------------------------
// What the sweep REFUSES to touch — the guards that only ever skip
// ---------------------------------------------------------------------------

async function testSweepSkipsLiveOwnerAndLiveIssue() {
  console.log("\n3. a live owner or a live sibling issue is never touched");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-live");
  const mine = makeSweepWorktree(repoRoot, baseSha, "issue-7-default", {
    dirty: true,
  });
  const theirs = makeSweepWorktree(repoRoot, baseSha, "issue-8-default", {
    dirty: true,
  });
  const stranger = makeSweepWorktree(repoRoot, baseSha, "issue-9-default", {
    dirty: true,
  });
  // `selfPid` is the sweep's own process, so the owner pid must differ from it
  // for Rule 3a to fire at all — that is the self-exemption, not an oversight.
  // A detached child parked on a stdin read is the honest way to hold a pid
  // this test can reap, rather than a number that happens to be free.
  const parked = spawn("cat", [], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
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
  console.log("\n4. the launching cycle's own tree is skipped (the guard that never fired)");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-own");
  const own = makeSweepWorktree(repoRoot, baseSha, "issue-1006-default", {
    dirty: true,
  });
  const integrate = makeSweepWorktree(repoRoot, baseSha, "issue-1006-integrate", { dirty: true });
  const foreign = makeSweepWorktree(repoRoot, baseSha, "issue-11-default", {
    dirty: true,
  });
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
  console.log("\n5. an awaiting-human-merge park purges artifacts and keeps the tree");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-mergehold");
  const wt = makeSweepWorktree(repoRoot, baseSha, "issue-7-default", {
    dirty: true,
  });
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

// ---------------------------------------------------------------------------
// runWorktreeTeardown — the in-cycle path, which never reaches the sweep
// ---------------------------------------------------------------------------

async function testRunWorktreeTeardown() {
  console.log("\n6. in-cycle teardown retains what it must and removes what it may");
  const { repoRoot, baseSha } = makeSweepRepo("pi-rukas-sweep-teardown");
  const wt = makeSweepWorktree(repoRoot, baseSha, "issue-7-default", {
    dirty: true,
  });
  const state: WorkState = {
    ...abortedState(7),
    pipelineState: {
      ...abortedState(7).pipelineState,
      worktrees: { default: wt.path },
    },
  };
  const rec = recordingExec();
  const retained = await runWorktreeTeardown({
    repoRoot,
    state,
    execFn: rec.exec,
  });
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

async function runTests() {
  await testSweepDoesNotClaimASuppressedPurge();
  await testSweepRefusesForeignSchemaState();
  await testSweepSkipsLiveOwnerAndLiveIssue();
  await testSweepSkipsLaunchingCycleOwnTree();
  await testSweepPurgesAwaitingHumanMerge();
  await testRunWorktreeTeardown();
  finish();
}

await runTests();
