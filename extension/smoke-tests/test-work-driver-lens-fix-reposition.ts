#!/usr/bin/env bun
// #981 task-b — repositionLensFixWorktree: the fix dispatch moves the lens-fix
// worktree to the branch tip. The guard returns a discriminated union; only
// `already-at-tip` and `repositioned` are safe to dispatch on.
import { exec } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";

const execp = promisify(exec);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-repos-"));
  try {
    const origin = path.join(dir, "origin.git");
    const root = path.join(dir, "root");
    const wt = path.join(dir, "wt");
    await execp("git init -q --bare --initial-branch=main origin.git", { cwd: dir });
    await execp("git init -q --initial-branch=main root", { cwd: dir });
    await execp('git config user.email "t@t" && git config user.name "T"', {
      cwd: root,
      shell: "/bin/bash",
    });
    writeFileSync(path.join(root, "a.txt"), "one\n");
    writeFileSync(path.join(root, "b.txt"), "two\n");
    await execp("git add . && git commit -q -m base", { cwd: root, shell: "/bin/bash" });
    await execp(`git remote add origin ${JSON.stringify(origin)} && git push -q -u origin main`, {
      cwd: root,
    });
    await execp("git checkout -qb feature/lens-repos && git push -q -u origin feature/lens-repos", {
      cwd: root,
    });
    const baseSha = (await execp("git rev-parse HEAD", { cwd: root })).stdout.trim();
    await execp(`git worktree add --detach ${JSON.stringify(wt)} ${JSON.stringify(baseSha)}`, {
      cwd: root,
    });

    const repositionExec = (cmd: string, o?: { cwd?: string }) =>
      execp(cmd, { cwd: o?.cwd ?? root, shell: "/bin/bash" }) as Promise<{ stdout: string }>;

    // Case 1: the worktree is at the branch tip (the common case — the
    // fixer started from the tip). The reposition returns already-at-tip.
    const r1 = await repositionLensFixWorktree(
      repositionExec,
      wt,
      "feature/lens-repos",
      [981],
      "reposition test",
    );
    assert(
      r1.kind === "already-at-tip",
      `981 reposition: a worktree at the branch tip is already-at-tip (got ${r1.kind})`,
    );

    // Case 2: the worktree has DIVERGED from the branch tip (the fixer
    // committed work on a different base than the branch, AND the branch
    // tip advanced via a commit in repoRoot). The guard returns diverged
    // and the worktree is backed up.
    await execp(`git checkout -q --detach ${JSON.stringify(baseSha)}`, { cwd: wt });
    writeFileSync(path.join(wt, "c.txt"), "three\n");
    await execp("git add . && git commit -q -m 'fixer work'", { cwd: wt, shell: "/bin/bash" });
    // Advance the branch tip in repoRoot (diverges from the worktree's
    // "fixer work" commit).
    writeFileSync(path.join(root, "b.txt"), "two\nbr advance\n");
    await execp("git add . && git commit -q -m 'br advance'", { cwd: root, shell: "/bin/bash" });
    await execp("git push -q origin feature/lens-repos", { cwd: root });
    const r2 = await repositionLensFixWorktree(
      repositionExec,
      wt,
      "feature/lens-repos",
      [981],
      "reposition test",
    );
    assert(
      r2.kind === "diverged",
      `981 reposition: a diverged worktree returns diverged (got ${r2.kind})`,
    );
    assert(
      r2.kind === "diverged" && r2.backupRef !== undefined,
      "981 reposition: a diverged worktree has a backup ref",
    );
    // The worktree's fixer work is still at HEAD (not destroyed).
    const wtLog = (await execp("git log --oneline -1", { cwd: wt })).stdout.trim();
    assert(
      wtLog.includes("fixer work"),
      "981 reposition: the worktree's fixer work is unchanged after the diverged guard",
    );

    // Case 3: the worktree is at the old base (the branch has advanced via
    // a prior lens-fix round integration and been pushed). The guard
    // fast-forwards the worktree to the current remote tip.
    await execp(`git checkout -q --detach ${JSON.stringify(baseSha)}`, { cwd: wt });
    const r3 = await repositionLensFixWorktree(
      repositionExec,
      wt,
      "feature/lens-repos",
      [981],
      "reposition test",
    );
    assert(
      r3.kind === "repositioned",
      `981 reposition: a worktree at the old base repositions to the advanced branch tip (got ${r3.kind})`,
    );
    const wtHeadAfter = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();
    const branchTip = (await execp("git rev-parse feature/lens-repos", { cwd: root })).stdout.trim();
    assert(
      wtHeadAfter === branchTip,
      "981 reposition: the worktree is at the branch tip after the reposition",
    );
    const wtB = (await execp("git show HEAD:b.txt", { cwd: wt })).stdout;
    assert(
      wtB.includes("br advance"),
      "981 reposition: the worktree sees the branch's new content",
    );

    // Case 4: dirty worktree — the guard returns dirty without moving.
    await execp("git checkout -q --detach", { cwd: wt });
    writeFileSync(path.join(wt, "dirty.txt"), "dirty\n");
    const r4 = await repositionLensFixWorktree(
      repositionExec,
      wt,
      "feature/lens-repos",
      [981],
      "reposition test",
    );
    assert(
      r4.kind === "dirty",
      `981 reposition: a dirty worktree returns dirty (got ${r4.kind})`,
    );
    // The worktree HEAD is unchanged (still at where case 3 left it).
    const wtHeadDirty = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();
    assert(
      wtHeadDirty === branchTip,
      "981 reposition: a dirty worktree is not moved",
    );

    console.log("✓ 981 reposition test passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
