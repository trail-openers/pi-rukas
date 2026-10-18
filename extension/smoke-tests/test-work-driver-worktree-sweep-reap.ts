import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  findOwningCycleState,
  resolveSweepTarget,
  runWorktreeSweep,
} from "../src/work-driver-worktree-sweep.ts";

const execAsync = promisify(execFile);

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

/** A scratch repo with the three paths resolveSweepTarget realpathSync's. */
async function scratchRepo(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "sweep-ownership-"));
  await execAsync("git", ["init"], { cwd: dir });
  await execAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execAsync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: dir });
  await fs.mkdir(join(dir, ".worktrees"), { recursive: true });
  return dir;
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

    const foundA = findOwningCycleState(dir, wtA, 1427);
    assertTrue(foundA.state !== null, "task-a's owner resolves through the worktrees map");
    assertEquals(foundA.ownerIssue, 1421, "the resolved owner is the claimant, not the basename");
    const foundB = findOwningCycleState(dir, wtB, 1427);
    assertTrue(foundB.state !== null, "every workstream in a multi-workstream cycle resolves");

    // The launching cycle's own tree is never swept, by ISSUE, not basename.
    const own = findOwningCycleState(dir, wtA, 1421);
    assertTrue(own.state === null, "the launching cycle's own tree is refused");

    // A tree no state file claims is refused rather than guessed at.
    const orphan = findOwningCycleState(dir, join(dir, ".worktrees", "issue-9999-default"), 1427);
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

async function runTests() {
  await testDeadClaimWorktreeResolution();
  await testRunWorktreeSweepReapsDeadOwner();
  console.log(exitCode === 0 ? "\nAll tests passed." : "\nFAILED");
  process.exit(exitCode);
}

runTests();
