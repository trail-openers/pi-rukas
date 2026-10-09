#!/usr/bin/env bun
// #981 task-b — repositionLensFixWorktree: the fix dispatch moves the lens-fix
// worktree to the branch tip (fetch-first; best-effort, fails on divergence).
import { exec } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-commit.ts";

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
    // fixer started from the tip). The reposition is a no-op fast-forward.
    const r1 = await repositionLensFixWorktree(repositionExec, wt, "feature/lens-repos");
    assert(r1 === true, "981 reposition: a worktree at the branch tip repositions (no-op ff)");

    // Case 2: the worktree has DIVERGED from the branch tip (the fixer
    // committed work on a different base than the branch, AND the branch
    // tip advanced via a commit in repoRoot). The worktree and the branch
    // have diverged (both are 1 commit ahead of baseSha but different
    // commits), so the reposition correctly fails.
    await execp(`git checkout -q --detach ${JSON.stringify(baseSha)}`, { cwd: wt });
    writeFileSync(path.join(wt, "c.txt"), "three\n");
    await execp("git add . && git commit -q -m 'fixer work'", { cwd: wt, shell: "/bin/bash" });
    // Advance the branch tip in repoRoot (diverges from the worktree's
    // "fixer work" commit).
    writeFileSync(path.join(root, "b.txt"), "two\nbr advance\n");
    await execp("git add . && git commit -q -m 'br advance'", { cwd: root, shell: "/bin/bash" });
    const r2 = await repositionLensFixWorktree(repositionExec, wt, "feature/lens-repos");
    // The worktree has diverged from the branch tip — the reposition
    // correctly fails (a diverged worktree cannot be fast-forwarded).
    assert(
      r2 === false,
      "981 reposition: a diverged worktree fails to reposition (cannot ff across divergence)",
    );
    const wtLog = (await execp("git log --oneline -1", { cwd: wt })).stdout.trim();
    assert(
      wtLog.includes("fixer work"),
      "981 reposition: the worktree's fixer work is unchanged after the failed reposition",
    );

    // Case 3: the worktree is at the old base (the branch has advanced via
    // a prior lens-fix round integration and been pushed). The reposition
    // fetches the current remote tip and fast-forwards the worktree to it.
    await execp(`git checkout -q --detach ${JSON.stringify(baseSha)}`, { cwd: wt });
    await execp("git push -q -u origin feature/lens-repos", { cwd: root });
    const r3 = await repositionLensFixWorktree(repositionExec, wt, "feature/lens-repos");
    assert(
      r3 === true,
      "981 reposition: a worktree at the old base repositions to the advanced branch tip (ff)",
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

    console.log("✓ 981 reposition test passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
