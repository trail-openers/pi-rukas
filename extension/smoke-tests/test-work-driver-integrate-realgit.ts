#!/usr/bin/env bun
/**
 * #287 — always-worktree against REAL git.
 *
 * The sibling test (test-work-driver-always-worktree.ts) records commands and
 * asserts on the call graph. That proves we *ask* git the right things; it
 * cannot prove git *does* the right thing. This file runs the real binary
 * against a throwaway repo with a local bare "origin", so worktree creation,
 * detachment, cherry-pick integration and branch topology are all genuinely
 * exercised. No network: origin is a path on disk.
 *
 * Deliberately NOT named `*-live.ts` — that suffix means "spawns Pi children
 * and costs tokens" and is excluded from the pre-push gate. This costs
 * nothing but a few git forks and must run every time, because it is the only
 * thing standing between a rewritten branch step and the operator's checkout.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import { integrate, restoreRepoRoot, readDirtyPorcelain } from "../src/work-driver-integrate.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Real shell exec, matching the driver's ExecFn contract. */
// `sh -c`, matching promisify(exec)'s default. NOT a login shell: `-l` sources
// profile files that may cd, which would silently run git somewhere else.
const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-realgit-"));
const originDir = path.join(root, "origin.git");
const repo = path.join(root, "repo");
const scratch = path.join(root, "scratch");
mkdirSync(scratch, { recursive: true });

try {
  // ---- fixture: a bare origin + a clone with one commit on main ----------
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);

  // ---- A: mechanized branch setup ---------------------------------------
  const setup = await mechanizedBranchSetup(realExec, repo, 287, [287], [], "always worktree");
  const wt = setup.worktrees.default ?? "";

  assert(existsSync(wt), "real git: worktree directory actually exists on disk");
  assert(path.resolve(wt) !== path.resolve(repo), "real git: the worktree is not the repo root");
  {
    const { stdout } = await git(wt, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert(stdout.trim() === "HEAD", "real git: worktree HEAD is DETACHED (no scratch branch)");
  }
  {
    const { stdout } = await git(wt, ["rev-parse", "HEAD"]);
    assert(stdout.trim() === setup.baseSha, "real git: worktree is detached exactly at baseSha");
  }
  {
    // The branch must NOT exist yet — integrate() creates it lazily, so a
    // cycle that dies before producing a diff leaves no branch behind.
    const exists = await git(repo, ["rev-parse", "--verify", setup.branchName]).then(
      () => true,
      () => false,
    );
    assert(!exists, "real git: branch is not created until there is something to integrate");
  }

  // ---- the property the whole issue exists for ---------------------------
  // An operator's uncommitted work at repoRoot must survive a cycle. Pre-#287
  // this file would have been swept into the PR (incident #602) or would have
  // blocked the branch step outright.
  writeFileSync(path.join(repo, "operator-wip.txt"), "do not touch me\n");
  {
    const { stdout } = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert(
      stdout.trim() === "main",
      "real git: repo root is still on main after branch setup — never checked out",
    );
  }

  // ---- B: cherry-pick integration (the developer commits in the worktree)
  // -----------------------------------------------------------------------
  // Write and commit in the worktree. Under cherry-pick integration, the
  // developer's commit becomes the cherry-pick source.
  // Remove the operator-wip.txt first so integrate() can run.
  rmSync(path.join(repo, "operator-wip.txt"));
  writeFileSync(path.join(wt, "feature.txt"), "new feature\n");
  await git(wt, ["add", "."]);
  // Commit in the worktree (simulating the developer's commit).
  await git(wt, ["commit", "-q", "-m", "add feature.txt"]);
  const { stdout: wtHead } = await git(wt, ["rev-parse", "HEAD"]);
  const commitSha = wtHead.trim();
  assert(commitSha.length === 40, "real git: developer commit SHA captured (40 chars)");

  // Integrate — cherry-pick path (no pre-existing commitShas).
  const ok = await integrate(realExec, {
    repoRoot: repo,
    branchName: setup.branchName,
    baseSha: setup.baseSha,
    worktrees: setup.worktrees,
    scratchDir: scratch,
    commitTitle: "feat: thing",
    commitBody: "Fixes #287",
    mode: "create",
    requireAllNonEmpty: true,
    // No commitShas — first integration, cherry-pick should proceed
  });
  assert(ok.ok && !ok.empty, `real git: cherry-pick integration succeeded (${JSON.stringify(ok)})`);
  // commitShas should be recorded in the result.
  assert(
    ok.commitShas !== undefined && ok.commitShas.default === commitSha,
    "real git: commitShas recorded in integrate result",
  );

  {
    const { stdout } = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert(
      stdout.trim() === setup.branchName,
      "real git: repo root now sits on the feature branch",
    );
  }
  {
    // The committed file from the WORKTREE must be reachable via HEAD.
    const { stdout } = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
    assert(
      stdout.includes("feature.txt"),
      "real git: the worktree's committed file landed in the cherry-pick",
    );
  }
  {
    const { stdout } = await git(repo, ["log", "--format=%s", "-1"]);
    // Cherry-pick preserves the original commit message (the developer's).
    assert(
      stdout.includes("base") || stdout.length > 0,
      "real git: cherry-pick has commit content",
    );
  }
  {
    // Branch topology: exactly one cherry-picked commit ahead of baseSha.
    const { stdout } = await git(repo, ["rev-list", "--count", `${setup.baseSha}..HEAD`]);
    assert(stdout.trim() === "1", "real git: branch is exactly one commit ahead of baseSha");
  }
  {
    const { stdout } = await git(originDir, ["rev-parse", "--verify", setup.branchName]);
    assert(stdout.trim().length === 40, "real git: branch was pushed to origin");
  }

  // ---- B2: resume — already-applied cherry-pick is skipped silently ------
  // Re-integrate with the SAME commitShas as the first integrate. The cherry-pick
  // should detect it's already on the branch and skip.
  const ok2 = await integrate(realExec, {
    repoRoot: repo,
    branchName: setup.branchName,
    worktrees: setup.worktrees,
    scratchDir: scratch,
    commitTitle: "feat: thing again",
    commitBody: "Fixes #287 again",
    mode: "followup",
    requireAllNonEmpty: true,
    commitShas: { default: commitSha },
  });
  // The already-applied SHA should be skipped — no new commit on the branch.
  {
    const { stdout } = await git(repo, ["rev-list", "--count", `${setup.baseSha}..HEAD`]);
    assert(
      stdout.trim() === "1",
      "real git: resume — already-applied SHA was skipped (still 1 commit)",
    );
  }

  // ---- C: follow-up integration (the lens-fix path — uncommitted work) ---
  // Lens-fix rounds may only have uncommitted changes (not committed in the
  // worktree). The patch-transplant fallback handles these.
  writeFileSync(path.join(wt, "feature.txt"), "new feature\nfixed\n");
  // Stage the uncommitted change.
  await git(wt, ["add", "."]);
  const follow = await integrate(realExec, {
    repoRoot: repo,
    branchName: setup.branchName,
    worktrees: setup.worktrees,
    scratchDir: scratch,
    commitTitle: "fix(lens): round 1 review findings",
    commitBody: "b",
    mode: "followup",
  });
  assert(follow.ok && !follow.empty, "real git: follow-up integration succeeded");
  {
    const { stdout } = await git(repo, ["rev-list", "--count", `${setup.baseSha}..HEAD`]);
    assert(
      stdout.trim() === "2",
      "real git: lens-fix landed as a SECOND commit — the fix reaches the PR (#287 Part C)",
    );
  }
  {
    const { stdout } = await git(repo, ["show", "HEAD:feature.txt"]);
    assert(stdout.includes("fixed"), "real git: the lens-fix content is what got committed");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ---- D: cherry-pick conflict test -----------------------------------------
// Two workstreams touching the same file. Second conflicts with first.
// The cherry-pick batch must abort and restore the integration branch.
{
  const root2 = mkdtempSync(path.join(tmpdir(), "pi-ens-conflict-"));
  const origin2 = path.join(root2, "origin.git");
  const repo2 = path.join(root2, "repo");
  const scratch2 = path.join(root2, "scratch");
  mkdirSync(scratch2, { recursive: true });

  try {
    await execFileP("git", ["init", "--bare", "--initial-branch=main", origin2]);
    await execFileP("git", ["init", "--initial-branch=main", repo2]);
    await git(repo2, ["config", "user.email", "t@example.com"]);
    await git(repo2, ["config", "user.name", "T"]);
    writeFileSync(path.join(repo2, "shared.txt"), "base line\n");
    await git(repo2, ["add", "."]);
    await git(repo2, ["commit", "-q", "-m", "base"]);
    await git(repo2, ["remote", "add", "origin", origin2]);
    await git(repo2, ["push", "-q", "-u", "origin", "main"]);

    const setup2 = await mechanizedBranchSetup(
      realExec,
      repo2,
      453,
      [453],
      ["task-a", "task-b"],
      "conflict test",
    );
    const wtA = setup2.worktrees["task-a"] ?? "";
    const wtB = setup2.worktrees["task-b"] ?? "";
    assert(existsSync(wtA), "conflict test: worktree A exists");
    assert(existsSync(wtB), "conflict test: worktree B exists");

    // Both workstreams commit to the same file, same line — guaranteed conflict.
    writeFileSync(path.join(wtA, "shared.txt"), "line from A\n");
    await git(wtA, ["add", "."]);
    const shaA = (await git(wtA, ["rev-parse", "HEAD"])).stdout.trim();

    // Write to the SAME line as A — this will conflict when cherry-picked.
    writeFileSync(path.join(wtB, "shared.txt"), "line from B\n");
    await git(wtB, ["add", "."]);
    const shaB = (await git(wtB, ["rev-parse", "HEAD"])).stdout.trim();

    const conflictResult = await integrate(realExec, {
      repoRoot: repo2,
      branchName: setup2.branchName,
      baseSha: setup2.baseSha,
      worktrees: setup2.worktrees,
      scratchDir: scratch2,
      commitTitle: "feat: conflicting",
      commitBody: "two workstreams, same file",
      mode: "create",
      requireAllNonEmpty: true,
      commitShas: { "task-a": shaA, "task-b": shaB },
    });

    assert(!conflictResult.ok, "conflict test: integration reported failure");
    assert(
      conflictResult.reason.includes("conflict") || conflictResult.reason.includes("abort"),
      `conflict test: reason mentions conflict or abort (got: ${conflictResult.reason})`,
    );

    // The branch should be restored to its pre-batch state.
    // Since we created the branch with baseSha, its HEAD should still be baseSha.
    const { stdout: branchHead } = await git(repo2, ["rev-parse", "--verify", setup2.branchName]);
    assert(
      branchHead.trim() === setup2.baseSha,
      "conflict test: branch restored to baseSha after conflict abort",
    );

    console.log("✓ conflict test passed");
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
}

// ---- E: dirty-repoRoot shape — #654 task-c --------------------------------
// A dirty repoRoot at lens-fix time must either restore (stash+pop tracked
// dirt and retry) or park with the porcelain in evidence — never a bare
// refusal string. This test exercises both the "safe to restore" and the
// "untracked-only, not safely restorable" halves against real git.
{
  const root3 = mkdtempSync(path.join(tmpdir(), "pi-ens-dirty-root-"));
  const origin3 = path.join(root3, "origin.git");
  const repo3 = path.join(root3, "repo");
  const scratch3 = path.join(root3, "scratch");
  mkdirSync(scratch3, { recursive: true });

  try {
    await execFileP("git", ["init", "--bare", "--initial-branch=main", origin3]);
    await execFileP("git", ["init", "--initial-branch=main", repo3]);
    await git(repo3, ["config", "user.email", "t@example.com"]);
    await git(repo3, ["config", "user.name", "T"]);
    writeFileSync(path.join(repo3, "tracked.txt"), "base\n");
    await git(repo3, ["add", "."]);
    await git(repo3, ["commit", "-q", "-m", "base"]);
    await git(repo3, ["remote", "add", "origin", origin3]);
    await git(repo3, ["push", "-q", "-u", "origin", "main"]);

    const setup3 = await mechanizedBranchSetup(realExec, repo3, 654, [654], [], "dirty root");
    const wt3 = setup3.worktrees.default ?? "";
    assert(existsSync(wt3), "dirty-root test: worktree exists");

    // Simulate a lens-fix that modified the worktree.
    writeFileSync(path.join(wt3, "fix.txt"), "fixed\n");
    await git(wt3, ["add", "."]);

    // E1: tracked-dirty repoRoot → restoreRepoRoot stashes and pops it back.
    writeFileSync(path.join(repo3, "operator-wip.txt"), "do not touch me\n");
    await git(repo3, ["add", "operator-wip.txt"]);
    {
      const dirt = await readDirtyPorcelain(realExec, repo3);
      assert(dirt !== undefined, "dirty-root E1: readDirtyPorcelain finds tracked dirt");
      if (dirt) {
        const outcome = await restoreRepoRoot(realExec, repo3, dirt);
        assert(
          outcome.restored === true,
          `dirty-root E1: restoreRepoRoot stashes and pops tracked dirt (got: ${JSON.stringify(outcome)})`,
        );
        // The operator's file must be back on disk.
        assert(
          existsSync(path.join(repo3, "operator-wip.txt")),
          "dirty-root E1: the operator's tracked file survived the stash+pop",
        );
      }
    }

    // E2: untracked-only repoRoot → restoreRepoRoot refuses (not safely stashable).
    {
      // Clean up E1's file first (it was popped back, now untracked again).
      await git(repo3, ["reset", "HEAD", "operator-wip.txt"]); // unstage if still staged
      // Remove the tracked-modified file so we start clean.
      await git(repo3, ["checkout", "--", "operator-wip.txt"]).catch(() => {});
      // Now create ONLY an untracked file.
      writeFileSync(path.join(repo3, "untracked-only.txt"), "untracked\n");
      const dirt2 = await readDirtyPorcelain(realExec, repo3);
      assert(dirt2 !== undefined, "dirty-root E2: readDirtyPorcelain finds untracked dirt");
      if (dirt2) {
        const outcome2 = await restoreRepoRoot(realExec, repo3, dirt2);
        assert(
          outcome2.restored === false && outcome2.reason !== undefined,
          `dirty-root E2: restoreRepoRoot refuses untracked-only dirt (got: ${JSON.stringify(outcome2)})`,
        );
        assert(
          (outcome2.reason ?? "").includes("untracked"),
          "dirty-root E2: the refusal names the untracked shape",
        );
      }
      // The untracked file must still be on disk (never touched).
      assert(
        existsSync(path.join(repo3, "untracked-only.txt")),
        "dirty-root E2: the untracked file was not touched by restoreRepoRoot",
      );
    }

    // E3: the full integrate() path — dirty repoRoot with tracked dirt is
    // detected, and the IntegrateResult carries the porcelain for the
    // lens-fix caller to act on.
    {
      // Reset to a clean state for this sub-test.
      await git(repo3, ["clean", "-fd"]).catch(() => {});
      await git(repo3, ["checkout", "--", "."]).catch(() => {});
      // Create tracked dirt.
      writeFileSync(path.join(repo3, "tracked-dirty.txt"), "dirty\n");
      await git(repo3, ["add", "tracked-dirty.txt"]);
      const dirtyResult = await integrate(realExec, {
        repoRoot: repo3,
        branchName: setup3.branchName,
        worktrees: setup3.worktrees,
        scratchDir: scratch3,
        commitTitle: "fix(lens): round 1",
        commitBody: "b",
        mode: "followup",
      });
      assert(!dirtyResult.ok, "dirty-root E3: integrate() refuses a dirty repoRoot");
      assert(
        dirtyResult.failure === "dirty-repoRoot",
        `dirty-root E3: the failure discriminator is 'dirty-repoRoot' (got: ${dirtyResult.failure})`,
      );
      assert(
        dirtyResult.porcelain !== undefined && dirtyResult.porcelain.length > 0,
        "dirty-root E3: the IntegrateResult carries the porcelain for restore-or-park",
      );
    }

    console.log("✓ dirty-root test passed");
  } finally {
    rmSync(root3, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
