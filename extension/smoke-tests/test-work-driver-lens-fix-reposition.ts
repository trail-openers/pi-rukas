#!/usr/bin/env bun
// #981 task-b — repositionLensFixWorktree: the fix dispatch moves the lens-fix
// worktree to the branch tip. The guard returns a discriminated union; only
// `already-at-tip` and `repositioned` are safe to dispatch on.
import { exec, execFile } from "node:child_process";
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

    // The gate's git calls use the argv form (no shell re-parse) — the test
    // executor must honour it, mirroring lens-exec.ts's execp contract.
    // The argv form is `cmd = executable, argv = arguments` (see #1005 in
    // work-driver-verify.ts and lens-exec.ts).
    const repositionExec = async (cmd: string, o?: { cwd?: string; argv?: string[] }) => {
      if (o?.argv) {
        const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) =>
          execFile(cmd, o.argv!, { cwd: o.cwd ?? root, encoding: "utf8" }, (err, so) =>
            err ? reject(err) : resolve({ stdout: so }),
          ),
        );
        return { stdout };
      }
      return (await execp(cmd, { cwd: o?.cwd ?? root, shell: "/bin/bash" })) as { stdout: string };
    };

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

    // Case 5: cherry-landed path, but the backup ref creation fails
    // (`git update-ref` rejects). The gate must park (diverged, no backup
    // ref) and the tree HEAD must be UNCHANGED — the old worktree commit is
    // still there (not orphaned by a detach checkout).
    await execp(`git checkout -q --detach ${JSON.stringify(baseSha)}`, { cwd: wt });
    const wtHeadBefore = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();
    const tipShaBefore = (await execp("git rev-parse feature/lens-repos", { cwd: root }))
      .stdout.trim();
    await execp("git checkout -q --detach HEAD~0", { cwd: wt, shell: "/bin/bash" });
    writeFileSync(path.join(wt, "c.txt"), "three\ncherry case\n");
    await execp("git add . && git commit -q -m 'cherry case work'", { cwd: wt, shell: "/bin/bash" });
    const fixCommitSha = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();
    // Land the fix on the branch as a cherry-pick (the normal #981 shape),
    // so the worktree is NOT an ancestor of the tip and every cherry line
    // is `-`.
    await execp(`git cherry-pick ${JSON.stringify(fixCommitSha)}`, { cwd: root, shell: "/bin/bash" });
    await execp("git push -q origin feature/lens-repos", { cwd: root });
    const tipShaAfter = (await execp("git rev-parse feature/lens-repos", { cwd: root }))
      .stdout.trim();
    assert(
      tipShaAfter !== tipShaBefore,
      "981 reposition (backup fail): the cherry-pick advanced the branch tip",
    );
    // The worktree is still on the ORIGINAL fix commit (a patch-equivalent
    // of the cherry-pick, not the cherry-pick itself) — this is the #981
    // normal shape the gate must reposition.
    const execBackupFail = async (cmd: string, o?: { cwd?: string; argv?: string[] }) => {
      if (o?.argv && o.argv[0] === "update-ref") {
        throw new Error("simulated backup ref failure (git update-ref refused)");
      }
      return repositionExec(cmd, o);
    };
    const r5 = await repositionLensFixWorktree(
      execBackupFail,
      wt,
      "feature/lens-repos",
      [981],
      "reposition test",
    );
    assert(
      r5.kind === "diverged",
      `981 reposition: cherry path with a failed backup ref parks (got ${r5.kind})`,
    );
    assert(
      r5.kind === "diverged" && r5.detail.includes("backup ref could not be created"),
      "981 reposition: the park detail names the failed backup ref",
    );
    assert(
      r5.kind === "diverged" && r5.backupRef === undefined,
      "981 reposition: no backup ref is recorded when creation failed",
    );
    const wtHeadAfter5 = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();
    assert(
      wtHeadAfter5 === fixCommitSha && wtHeadAfter5 !== wtHeadBefore,
      "981 reposition: the tree HEAD is unchanged when the backup ref fails",
    );

    console.log("✓ 981 reposition test passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
