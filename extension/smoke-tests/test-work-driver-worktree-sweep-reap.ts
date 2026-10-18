import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
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
 * #1454 — the sweep resolved the owning cycle by guessing `.pi/work-state/
 * <worktree-basename>.json`, but worktree directories are named
 * `issue-<N>-<workstream>` while state files are `<N>.json`. Every
 * multi-workstream tree therefore read "state-unreadable" and was skipped, so
 * a crashed cycle's footprint was never reaped whatever its liveness. The owner
 * is now resolved through `pipelineState.worktrees` (the id→path map).
 */
async function testDeadClaimWorktreeResolution() {
  console.log("\nTesting dead-owner worktree → state resolution (#1454)...");
  const dir = await scratchRepo();
  const wtA = join(dir, ".worktrees", "issue-1421-task-a");
  const wtB = join(dir, ".worktrees", "issue-1421-task-b");
  try {
    const stateDir = join(dir, ".pi", "work-state");
    await fs.mkdir(stateDir, { recursive: true });
    // The real names: directories carry the workstream suffix, state files do not.
    const claimant = {
      schemaVersion: 1,
      resumable: false,
      owner: { pid: 999999, at: Date.now() - 5_220_000 },
      issue: 1421,
      issues: [1421, 1422],
      startedAt: Date.now() - 6_000_000,
      updatedAt: Date.now() - 5_220_000,
      pipelineState: {
        currentStep: "develop",
        inFlightJobIds: ["develop:1"],
        worktrees: { "task-a": wtA, "task-b": wtB },
        reviewRound: 0,
        ciRetryCount: 0,
        plumbReports: [],
        status: "running",
      },
      eventLog: [],
    };
    await fs.writeFile(join(stateDir, "1421.json"), JSON.stringify(claimant));

    // r2 — the index is a REQUIRED argument. It used to be optional with a
    // default that re-read `.pi/work-state/` per call, which is the cost the
    // index exists to remove and did it invisibly. Every caller builds it once
    // per sweep; this is the shape a sweep actually uses.
    const index = buildOwnerIndex(dir);
    const foundA = findOwningCycleState(dir, wtA, 1427, index);
    assertTrue(foundA.state !== null, "task-a's owner resolves through the worktrees map");
    assertEquals(foundA.ownerIssue, 1421, "the resolved owner is the claimant, not the basename");
    const foundB = findOwningCycleState(dir, wtB, 1427, index);
    assertTrue(foundB.state !== null, "every workstream in a multi-workstream cycle resolves");

    // The launching cycle's own tree is never swept, by ISSUE, not basename.
    const own = findOwningCycleState(dir, wtA, 1421, index);
    assertTrue(own.state === null, "the launching cycle's own tree is refused");

    // A tree no state file claims is refused rather than guessed at.
    const orphan = findOwningCycleState(
      dir,
      join(dir, ".worktrees", "issue-9999-default"),
      1427,
      index,
    );
    assertTrue(orphan.state === null, "an unclaimed tree resolves to no owner");

    // Path traversal stays refused: a path outside .worktrees/ is never a
    // target, whichever map named it. Asserted through resolveSweepTarget —
    // the gate both the sweep loop and the teardown loop actually call.
    await fs.writeFile(join(dir, "package.json"), "{}\n");
    const traversal = resolveSweepTarget(dir, join(dir, "package.json"));
    assertFalse(traversal.ok, "a path outside .worktrees/ is refused by resolveSweepTarget");
    assertEquals(
      (traversal as { reason?: string }).reason,
      "outside-worktrees",
      "the refusal names the path escape, not a generic failure",
    );
    const escape = resolveSweepTarget(dir, "/etc");
    assertFalse(escape.ok, "an absolute path outside the repo is refused");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * #1454 — the end-to-end half: a dead cycle's real worktree is reaped, and the
 * ladder chose PURGE (git clean -fdX) rather than removal, so a crashed cycle
 * with work that is not provably on the remote keeps an inspectable tree.
 */
async function testRunWorktreeSweepReapsDeadOwner() {
  console.log("\nTesting runWorktreeSweep reaps a dead owner's worktree (#1454)...");
  const dir = await scratchRepo();
  const wtPath = join(dir, ".worktrees", "issue-1431-task-a");
  try {
    // The ignore rule must be committed BEFORE the tree is created — a linked
    // worktree checks out the tracked .gitignore, and without it `git clean
    // -fdX` has nothing to match and the purge is a no-op.
    await fs.writeFile(join(dir, ".gitignore"), "build/\n");
    await execAsync("git", ["add", ".gitignore"], { cwd: dir });
    await execAsync("git", ["commit", "-m", "ignore build output"], { cwd: dir });
    await execAsync("git", ["worktree", "add", "--detach", wtPath, "HEAD"], { cwd: dir });
    // Uncommitted work + a git-ignored build artefact: the purge must clear the
    // latter and must never destroy the tree.
    await fs.writeFile(join(wtPath, "uncommitted.txt"), "the developer's unwritten work\n");
    await fs.mkdir(join(wtPath, "build"), { recursive: true });
    await fs.writeFile(join(wtPath, "build", "stale.js"), "artifact\n");

    const stateDir = join(dir, ".pi", "work-state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      join(stateDir, "1431.json"),
      JSON.stringify({
        schemaVersion: 1,
        resumable: false,
        owner: { pid: 999999, at: Date.now() - 7_200_000 },
        issue: 1431,
        startedAt: Date.now() - 7_200_000,
        updatedAt: Date.now() - 7_200_000,
        pipelineState: {
          currentStep: "develop",
          inFlightJobIds: ["develop:1"],
          worktrees: { "task-a": wtPath },
          reviewRound: 0,
          ciRetryCount: 0,
          plumbReports: [],
          status: "running",
        },
        eventLog: [],
      }),
    );

    const result = await runWorktreeSweep({
      repoRoot: dir,
      launchingCycleIssue: 1427,
      liveCycles: new Set([1427]),
      execFn: async (cmd, opts) => {
        const argv = cmd.startsWith("git ") ? cmd.slice(4).split(/\s+/) : [cmd];
        const { stdout } = await execAsync("git", argv as string[], { cwd: opts?.cwd });
        return { stdout, stderr: undefined };
      },
    });
    assertTrue(result.ran, "the sweep ran");
    assertTrue(
      result.purged.includes(wtPath),
      "the dead owner's tree was PURGED (not removed) — uncommitted work stays inspectable",
    );
    assertTrue(result.removed.length === 0, "nothing was removed while its work was unproven");
    const stillThere = await fs.stat(wtPath).then(
      () => true,
      () => false,
    );
    assertTrue(stillThere, "the tree itself survives — purge cleans artifacts, not the checkout");
    const ignored = await fs.stat(join(wtPath, "build")).then(
      () => true,
      () => false,
    );
    assertFalse(ignored, "the git-ignored build artefact was cleaned by the purge");
  } finally {
    await execAsync("git", ["worktree", "remove", "--force", wtPath], { cwd: dir }).catch(
      () => undefined,
    );
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * #1454 r2 — `findOwningCycleState` matched `pipelineState.worktrees` paths
 * with a bare `resolve()`, so a claim that pointed outside `.worktrees/` was
 * trusted from the map and handed to the ladder, which ends in `git clean
 * -fdX`. State files are operator-editable disk data: the same
 * `resolveSweepTarget` gate the sweep loop applies to every directory it
 * walks must apply to every path a state file NAMES.
 *
 * Also pinned here: the state-file filters. `*.json` pulled in
 * `path-claims.json`, `queue-summary.json` and `writeSnapshot`'s `*.tmp`
 * scratch as candidate WorkStates, and a file that parsed but was not a
 * WorkState reached `decideSweepAction`, which reads `eventLog.filter`.
 */
async function testOwnerClaimsAreValidated() {
  console.log("\nTesting sweep owner-path validation (#1454 r2)...");
  const dir = await scratchRepo();
  const legit = join(dir, ".worktrees", "issue-1440-task-a");
  try {
    const stateDir = join(dir, ".pi", "work-state");
    await fs.mkdir(stateDir, { recursive: true });

    // A real, claimable worktree — the control the hostile claims sit beside.
    await execAsync("git", ["worktree", "add", "--detach", legit, "HEAD"], { cwd: dir });

    // The repo root and a path outside .worktrees/, both named by state files.
    await fs.writeFile(join(dir, "victim.txt"), "must not be cleaned\n");

    const state = (issue: number, worktrees: Record<string, string>) => ({
      schemaVersion: 1,
      resumable: false,
      owner: { pid: 999999, at: Date.now() - 7_200_000 },
      issue,
      startedAt: Date.now() - 7_200_000,
      updatedAt: Date.now() - 7_200_000,
      pipelineState: {
        currentStep: "develop",
        inFlightJobIds: [],
        worktrees,
        reviewRound: 0,
        ciRetryCount: 0,
        plumbReports: [],
        status: "running",
      },
      eventLog: [],
    });

    await fs.writeFile(
      join(stateDir, "1440.json"),
      JSON.stringify(state(1440, { "task-a": legit })),
    );
    // A state file whose ONLY claim is the repo root — the self-grant shape.
    await fs.writeFile(join(stateDir, "1441.json"), JSON.stringify(state(1441, { default: dir })));
    // And one claiming an arbitrary file outside .worktrees/.
    await fs.writeFile(
      join(stateDir, "1442.json"),
      JSON.stringify(state(1442, { default: join(dir, "victim.txt") })),
    );

    const legitFound = findOwningCycleState(dir, legit, 1427, buildOwnerIndex(dir));
    assertTrue(legitFound.state !== null, "a claim inside .worktrees/ still resolves");
    assertEquals(legitFound.ownerIssue, 1440, "the legit claim's owner is the claiming cycle");

    const idx = buildOwnerIndex(dir);
    const rootClaim = findOwningCycleState(dir, dir, 1427, idx);
    assertTrue(rootClaim.state === null, "a state file claiming the repo root is refused");
    const fileClaim = findOwningCycleState(dir, join(dir, "victim.txt"), 1427, idx);
    assertTrue(fileClaim.state === null, "a state file claiming a plain file is refused");

    const index = buildOwnerIndex(dir);
    const indexedPaths = [...index.byPath.keys()];
    assertTrue(
      indexedPaths.every((p) => p.startsWith(join(dir, ".worktrees"))),
      "buildOwnerIndex indexes nothing outside .worktrees/",
    );
    assertTrue(
      index.byPath.has(legit) || index.byPath.has(resolve(legit)),
      "the valid claim is present in the index",
    );

    // Non-state files in the same directory are never read as WorkStates.
    await fs.writeFile(join(stateDir, "path-claims.json"), JSON.stringify([{ issue: 7 }]));
    await fs.writeFile(join(stateDir, "queue-summary.json"), JSON.stringify({ groups: [] }));
    await fs.writeFile(join(stateDir, "1443.json.1234.tmp"), "{ half written");
    // A file that parses but is not a WorkState — the shape that would reach
    // decideSweepAction's `state.eventLog.filter`.
    await fs.writeFile(join(stateDir, "1444.json"), JSON.stringify({ hello: "world" }));
    const index2 = buildOwnerIndex(dir);
    assertTrue(
      index2.corrupt.includes("1444.json"),
      "a parseable non-WorkState is recorded as corrupt, not silently skipped",
    );
    const claims7 = [...index2.byPath.values()].some((e) => e.state.issue === 7);
    assertTrue(!claims7, "path-claims.json is never read as a cycle state file");

    await fs.writeFile(join(stateDir, "1445.json"), "{ not json");
    const index3 = buildOwnerIndex(dir);
    assertTrue(
      index3.corrupt.includes("1445.json"),
      "unparseable JSON is traced in the corrupt list rather than swallowed",
    );
  } finally {
    await execAsync("git", ["worktree", "remove", "--force", legit], { cwd: dir }).catch(
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
  const dir = await scratchRepo();
  const wtPath = join(dir, ".worktrees", "issue-1450-task-a");
  let live: { pid: number; stop: () => Promise<void> } | null = null;
  try {
    await fs.writeFile(join(dir, ".gitignore"), "build/\n");
    await execAsync("git", ["add", ".gitignore"], { cwd: dir });
    await execAsync("git", ["commit", "-m", "ignore build output"], { cwd: dir });
    await execAsync("git", ["worktree", "add", "--detach", wtPath, "HEAD"], { cwd: dir });
    // Unpushed work the sweep has no business destroying.
    await fs.writeFile(join(wtPath, "work-in-progress.rs"), "the aborted developer's work\n");
    await fs.mkdir(join(wtPath, "build"), { recursive: true });
    await fs.writeFile(join(wtPath, "build", "stale.js"), "artifact\n");

    // The claimant's pid is alive for the CLAIM half (that is the whole point:
    // a live pid must not keep a terminal cycle's paths reserved) but must be
    // dead by the time the SWEEP runs, whose rule 3 correctly refuses to touch
    // any tree whose owner pid is alive. So the claim is asserted first against
    // the live pid, then the state file's owner is aged to a corpse and the
    // sweep judged on that.
    live = await spawnLivePid();
    const stateDir = join(dir, ".pi", "work-state");
    await fs.mkdir(stateDir, { recursive: true });
    const abortedState = (ownerPid: number) => ({
      schemaVersion: 1,
      resumable: false,
      owner: { pid: ownerPid, at: Date.now() },
      issue: 1450,
      startedAt: Date.now() - 3_600_000,
      updatedAt: Date.now() - 60_000,
      pipelineState: {
        currentStep: "develop",
        inFlightJobIds: [],
        worktrees: { "task-a": wtPath },
        reviewRound: 0,
        ciRetryCount: 0,
        plumbReports: [],
        status: "aborted",
      },
      eventLog: [],
    });
    await fs.writeFile(join(stateDir, "1450.json"), JSON.stringify(abortedState(live.pid)));

    // --- half 1: the claim no longer reserves its paths.
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
    const sibling = await checkAndRegisterClaims(
      makeCtx(dir, 1451),
      makeState(1451, dir),
      { "task-a": { paths: [claimPath] } },
    );
    assertTrue(
      sibling.pipelineState.status === "running",
      "a sibling is NOT parked by the aborted claimant's stale claim",
    );

    // --- half 2: the tree is purged, never removed. The owner is now a corpse
    // (the cycle is over — that is what `aborted` reports), which is the only
    // state in which the sweep may act at all.
    await live.stop();
    live = null;
    await fs.writeFile(join(stateDir, "1450.json"), JSON.stringify(abortedState(999_999)));
    const result = await runWorktreeSweep({
      repoRoot: dir,
      launchingCycleIssue: 1451,
      // The aborted cycle is NOT live — that is what `aborted` asserts. Leaving
      // it in the set would trip rule 3's `live-issue` clause and the sweep
      // would decline for a reason unrelated to what is under test.
      liveCycles: new Set([1451]),
      execFn: async (cmd, opts) => {
        const argv = cmd.startsWith("git ") ? cmd.slice(4).split(/\s+/) : [cmd];
        const { stdout } = await execAsync("git", argv as string[], { cwd: opts?.cwd });
        return { stdout, stderr: undefined };
      },
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
  await testDeadClaimWorktreeResolution();
  await testOwnerClaimsAreValidated();
  await testRunWorktreeSweepReapsDeadOwner();
  console.log(exitCode === 0 ? "\nAll tests passed." : "\nFAILED");
  process.exit(exitCode);
}

runTests();
