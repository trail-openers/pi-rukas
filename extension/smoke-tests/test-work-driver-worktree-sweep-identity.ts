#!/usr/bin/env bun
/**
 * #1454 r2 — the sweep's IDENTITY and INDEX gates, and the aborted claimant.
 *
 * Split from test-work-driver-worktree-sweep-reap.ts for the 500-line gate
 * (AGENTS.md §12); that file keeps the owner-resolution and reap halves. The
 * harness (`scratchRepo`, `realGitExecFn`, `sweepState`) is in `lib/` beside
 * this so the two suites build a repo the same way.
 *
 * Three gates, each a real failure mode rather than a hypothetical:
 *
 *  - **Worktree identity is bidirectional.** The old gate accepted any directory
 *    whose `.git` file merely EQUALLED `gitdir: <repoGitPath>/worktrees/<name>`.
 *    That string is free to anyone who can write under `.worktrees/`, and the
 *    ladder it feeds ends in `git clean -fdX`. git writes the forward pointer
 *    and the admin dir's `gitdir` back-pointer as a PAIR, so the pair is the
 *    identity.
 *  - **The index rejects foreign shapes.** State files are operator-editable
 *    JSON. A `schemaVersion` from a newer driver, or a `worktrees` value that is
 *    a string / an array / an object of numbers, used to reach the ladder (or
 *    throw inside the index build on the launch path).
 *  - **An aborted claimant releases its claim and keeps its tree.** `aborted` is
 *    a terminal `status` but never a `currentStep`, so the claim goes (the state
 *    file proves it) while the tree stays (the remote check cannot be satisfied).
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  checkAndRegisterClaims,
  readClaims,
} from "../src/work-driver-path-claims.ts";
import {
  findOwningCycleState,
  resolveSweepTarget,
  runWorktreeSweep,
} from "../src/work-driver-worktree-sweep.ts";
import { buildOwnerIndex } from "../src/work-driver-worktree-sweep-owners.ts";
import {
  makeCtx,
  makeState,
  rawClaims,
  seedClaims,
  spawnLivePid,
} from "./lib/claims-test-helpers.ts";
import {
  execAsync,
  realGitExecFn,
  scratchRepo,
  sweepState,
  writeSweepState,
} from "./lib/worktree-sweep-harness.ts";

let exitCode = 0;
function assertTrue(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exitCode = 1;
  }
}
function assertFalse(cond: boolean, msg: string) {
  assertTrue(!cond, msg);
}
function assertEquals(actual: unknown, expected: unknown, msg: string) {
  assertTrue(actual === expected, `${msg} (got ${String(actual)}, want ${String(expected)})`);
}

/**
 * #1454 r2 — a worktree's identity is proved in BOTH directions.
 */
async function testWorktreeIdentityIsBidirectional() {
  console.log("\nTesting sweep worktree identity (#1454 r2)...");
  const dir = await scratchRepo("sweep-identity-");
  const real = join(dir, ".worktrees", "issue-1460-task-a");
  const forged = join(dir, ".worktrees", "issue-1461-task-a");
  try {
    await execAsync("git", ["worktree", "add", "--detach", real, "HEAD"], { cwd: dir });
    const good = resolveSweepTarget(dir, real);
    assertTrue(good.ok, "a real linked worktree of this repo is accepted");

    // A directory carrying the right-looking `.git` file but no git admin dir.
    await fs.mkdir(forged, { recursive: true });
    await fs.writeFile(
      join(forged, ".git"),
      `gitdir: ${join(dir, ".git", "worktrees", "issue-1461-task-a")}\n`,
    );
    const fake = resolveSweepTarget(dir, forged);
    assertFalse(fake.ok, "a forged .git pointer with no admin dir is refused");
    assertEquals(
      (fake as { reason?: string }).reason,
      "not-our-worktree",
      "the refusal names the identity failure",
    );

    // Admin dir present but its back-pointer aimed elsewhere: the forward
    // pointer alone must not be enough.
    const adminDir = join(dir, ".git", "worktrees", "issue-1461-task-a");
    await fs.mkdir(adminDir, { recursive: true });
    await fs.writeFile(join(adminDir, "gitdir"), "/somewhere/else/.git\n");
    const mismatched = resolveSweepTarget(dir, forged);
    assertFalse(mismatched.ok, "an admin dir whose gitdir points elsewhere is refused");
    assertEquals(
      (mismatched as { reason?: string }).reason,
      "not-our-worktree",
      "a back-pointer mismatch is the same refusal",
    );

    // And when both halves agree, it is accepted.
    await fs.writeFile(join(adminDir, "gitdir"), join(forged, ".git"));
    const agreed = resolveSweepTarget(dir, forged);
    assertTrue(agreed.ok, "a matching forward/back pointer pair is accepted");
  } finally {
    await execAsync("git", ["worktree", "remove", "--force", real], { cwd: dir }).catch(
      () => undefined,
    );
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * #1454 r2 — the index must reject shapes the ladder cannot read.
 */
async function testIndexRejectsForeignShapes() {
  console.log("\nTesting sweep index shape checks (#1454 r2)...");
  const dir = await scratchRepo("sweep-shapes-");
  try {
    // A future schema version: indexable shape, wrong schema.
    await writeSweepState(
      dir,
      1470,
      { ...sweepState({ issue: 1470, worktrees: { "task-a": join(dir, ".worktrees", "x") } }), schemaVersion: 99 },
    );
    // `worktrees` as a string, and as an array — both used to throw inside the
    // index build, on the launch path, before any decision was made.
    await writeSweepState(dir, 1471, {
      ...sweepState({ issue: 1471, worktrees: {} }),
      pipelineState: { worktrees: "all" },
    });
    await writeSweepState(dir, 1472, {
      ...sweepState({ issue: 1472, worktrees: {} }),
      pipelineState: { worktrees: [join(dir, ".worktrees", "y")] },
    });
    // A numeric worktree value inside an otherwise plain object.
    await writeSweepState(dir, 1473, {
      ...sweepState({ issue: 1473, worktrees: {} }),
      pipelineState: { worktrees: { "task-a": 42 } },
    });

    const index = buildOwnerIndex(dir);
    assertTrue(
      index.corrupt.includes("1470.json"),
      "a non-current schemaVersion is corrupt, never indexed or acted on",
    );
    const indexed = [...index.byPath.values()].map((e) => e.state.issue);
    assertTrue(!indexed.includes(1470), "the wrong-version state file indexes nothing");
    // The three malformed `worktrees` shapes must not throw and must not index.
    assertTrue(!indexed.includes(1471), "worktrees as a string indexes nothing");
    assertTrue(!indexed.includes(1472), "worktrees as an array indexes nothing");
    assertTrue(!indexed.includes(1473), "a numeric worktree value indexes nothing");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * #1454 r2 — `integrateWorktree` is the one worktree path the driver records
 * OUTSIDE the `worktrees` map, so it was the only state-file path the owner
 * index never saw and the sweep could never reap.
 */
async function testIntegrateWorktreeIsIndexed() {
  console.log("\nTesting integrateWorktree indexing (#1454 r2)...");
  const dir = await scratchRepo("sweep-integrate-");
  const integrate = join(dir, ".worktrees", "issue-1480-integrate");
  try {
    await execAsync("git", ["worktree", "add", "--detach", integrate, "HEAD"], { cwd: dir });
    // `worktrees` deliberately EMPTY — the claim lives only in the sibling
    // field, which is precisely the case that was invisible.
    await writeSweepState(
      dir,
      1480,
      sweepState({
        issue: 1480,
        worktrees: {},
        integrateWorktree: integrate,
        currentStep: "commit-pr",
      }),
    );
    const index = buildOwnerIndex(dir);
    assertTrue(
      index.byPath.has(integrate),
      "the driver-owned integrate tree is indexed from pipelineState.integrateWorktree",
    );
    const found = findOwningCycleState(dir, integrate, 1481, index);
    assertEquals(found.ownerIssue, 1480, "its owner resolves to the cycle that recorded it");

    // Same gate as every other claim: a hand-edited integrateWorktree outside
    // .worktrees/ is refused, not swept.
    await fs.writeFile(join(dir, "victim2.txt"), "x\n");
    await writeSweepState(
      dir,
      1481,
      sweepState({
        issue: 1481,
        worktrees: {},
        integrateWorktree: join(dir, "victim2.txt"),
        currentStep: "commit-pr",
      }),
    );
    const index2 = buildOwnerIndex(dir);
    assertTrue(
      ![...index2.byPath.keys()].some((p) => p.includes("victim2.txt")),
      "an integrateWorktree pointing outside .worktrees/ is refused by the same gate",
    );
  } finally {
    await execAsync("git", ["worktree", "remove", "--force", integrate], { cwd: dir }).catch(
      () => undefined,
    );
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * #1454 r2 — an ABORTED claimant with a live pid and unpushed work: its claim
 * is released, and the sweep PURGES its tree rather than removing it.
 *
 * Two halves, both load-bearing:
 *
 *  1. **The claim goes.** `aborted` is a terminal status, so the claimant's own
 *     state file is the proof — not the pid. Without the terminal-status rule
 *     the entry would park every later cycle touching those paths, which is the
 *     #1421 zombie with a different status word. A live pid is precisely the
 *     case a pid probe cannot decide.
 *  2. **The tree is kept.** `aborted` is a `status`, never a `currentStep`, so
 *     the remote-provable ladder cannot talk itself into REMOVE. An aborted
 *     cycle whose commits never landed keeps an inspectable tree, exactly like a
 *     crashed one — and unlike a merged one.
 */
async function testAbortedClaimantReleasesAndPurges() {
  console.log("\nTesting aborted claimant: claim released, tree purged not removed (#1454 r2)...");
  const dir = await scratchRepo("sweep-aborted-");
  const wtPath = join(dir, ".worktrees", "issue-1450-task-a");
  let live: { pid: number; stop: () => Promise<void> } | null = null;
  try {
    // The ignore rule must be committed BEFORE the tree exists, or `git clean
    // -fdX` has nothing to match and the purge half asserts nothing.
    await fs.writeFile(join(dir, ".gitignore"), "build/\n");
    await execAsync("git", ["add", ".gitignore"], { cwd: dir });
    await execAsync("git", ["commit", "-m", "ignore build output"], { cwd: dir });
    await execAsync("git", ["worktree", "add", "--detach", wtPath, "HEAD"], { cwd: dir });
    // Unpushed work the sweep has no business destroying.
    await fs.writeFile(join(wtPath, "work-in-progress.rs"), "the aborted developer's work\n");
    await fs.mkdir(join(wtPath, "build"), { recursive: true });
    await fs.writeFile(join(wtPath, "build", "stale.js"), "artifact\n");

    // The claimant's pid is genuinely alive for the CLAIM half — that is the
    // point: a live pid must not keep a terminal cycle's paths reserved. It has
    // to be dead by the time the SWEEP runs, whose rule 3 correctly refuses to
    // touch any tree whose owner pid is alive. So the claim is asserted against
    // the live pid first, then the owner is aged to a corpse and the sweep judged
    // on that.
    live = await spawnLivePid();
    await writeSweepState(dir, 1450, sweepState({ issue: 1450, worktrees: { "task-a": wtPath }, status: "aborted", ownerPid: live.pid }));

    const claimPath = "src/deep-module.ts";
    seedClaims(dir, [
      { issue: 1450, pid: live.pid, paths: [claimPath], startedAt: Date.now() - 60_000 },
    ]);
    const honoured = await readClaims(dir);
    assertTrue(
      !honoured.some((c) => c.issue === 1450),
      "an aborted claimant's entry is not honoured even though its pid is alive",
    );
    assertTrue(
      !rawClaims(dir).some((c) => c.issue === 1450),
      "the aborted claimant's entry is PRUNED from the registry, not just skipped",
    );
    // And a sibling is free to take those paths.
    const sibling = (
      await checkAndRegisterClaims(makeCtx(dir, 1451), makeState(1451, dir), {
        "task-a": { paths: [claimPath] },
      })
    ).state;
    assertTrue(
      sibling.pipelineState.status === "running",
      "a sibling is NOT parked by the aborted claimant's stale claim",
    );

    // --- half 2: the tree is purged, never removed. The owner is now a corpse
    // (the cycle is over — that is what `aborted` reports), the only state in
    // which the sweep may act at all.
    await live.stop();
    live = null;
    await writeSweepState(
      dir,
      1450,
      sweepState({ issue: 1450, worktrees: { "task-a": wtPath }, status: "aborted" }),
    );
    const result = await runWorktreeSweep({
      repoRoot: dir,
      launchingCycleIssue: 1451,
      // The aborted cycle is NOT live — that is what `aborted` asserts. Leaving
      // it in the set would trip rule 3's `live-issue` clause and the sweep would
      // decline for a reason unrelated to what is under test.
      liveCycles: new Set([1451]),
      execFn: realGitExecFn,
    });
    assertTrue(result.purged.includes(wtPath), "the aborted claimant's tree is PURGED");
    assertTrue(
      !result.removed.includes(wtPath),
      "the aborted claimant's tree is NOT removed — its work is unpushed",
    );
    const survives = await fs
      .stat(join(wtPath, "work-in-progress.rs"))
      .then(
        () => true,
        () => false,
      );
    assertTrue(survives, "the unpushed file survives the purge for later inspection");
    const artifact = await fs.stat(join(wtPath, "build")).then(
      () => true,
      () => false,
    );
    assertTrue(!artifact, "the git-ignored build artefact was still cleaned");
  } finally {
    if (live) await live.stop();
    await execAsync("git", ["worktree", "remove", "--force", wtPath], { cwd: dir }).catch(
      () => undefined,
    );
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function runTests() {
  await testWorktreeIdentityIsBidirectional();
  await testIndexRejectsForeignShapes();
  await testIntegrateWorktreeIsIndexed();
  await testAbortedClaimantReleasesAndPurges();
  console.log(exitCode === 0 ? "\nAll tests passed." : "\nFAILED");
  process.exit(exitCode);
}

runTests();
