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
import { parkLensFixReposition } from "../src/work-driver-lens-fix-reposition-park.ts";
import { initialState } from "../src/workflow-state.ts";
import type { DriverContext } from "../src/work-driver-context.ts";

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

    // Task 1 (MEDIUM): a `git-failed` result that CARRIES a `backupRef`
    // (the cherry path made a backup ref, then the checkout failed) must
    // record `restoredToRef` on the cap-hit — previously only `unlanded` /
    // `diverged` results did, so the ref was lost. Verify the park helper
    // keeps it for a git-failed result.
    const parkDir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-park-"));
    try {
      const ctx = { pi: {}, repoRoot: parkDir, issue: 981 } as unknown as DriverContext;
      const state = initialState(981, Date.now());
      const parkNow = Date.now();
      const gitFailedWithRef = {
        kind: "git-failed",
        detail: "git checkout --detach <tip> failed: simulated",
        backupRef: "refs/pi-rukas/lens-fix-backup/slug/2026-01-01T00-00-00",
      } as const;
      const parked = await parkLensFixReposition(ctx, state, parkNow, "/tmp/wt", {
        kind: gitFailedWithRef.kind,
        detail: gitFailedWithRef.detail,
        backupRef: gitFailedWithRef.backupRef,
      });
      const capHit = [...parked.eventLog]
        .reverse()
        .find((e) => e.kind === "cap-hit" && e.cap === "lens-fix-reposition");
      assert(
        capHit !== undefined,
        "981 park: a git-failed result with backupRef produces a lens-fix-reposition cap-hit",
      );
      assert(
        capHit?.restoredToRef === gitFailedWithRef.backupRef,
        `981 park: the cap-hit's restoredToRef equals the git-failed backupRef (got ${String(capHit?.restoredToRef)})`,
      );
    } finally {
      rmSync(parkDir, { recursive: true, force: true });
    }

    // Task 2 (MEDIUM): `isAncestor` must distinguish "not an ancestor" (exit
    // 1 → false) from a git failure (e.g. a bad ref → exit 128). A merge-base
    // failure must NOT be read as `diverged` / `unlanded` — it must surface as
    // `git-failed` with the git error, and the tree must NOT move. Simulate a
    // `git merge-base` that fails with a non-1 exit code by pointing the worktree
    // at a ref that does not resolve.
    const badRefDir = mkdtempSync(path.join(tmpdir(), "work-driver-lens-badref-"));
    try {
      const origin = path.join(badRefDir, "origin.git");
      const root = path.join(badRefDir, "root");
      const wt = path.join(badRefDir, "wt");
      await execp("git init -q --bare --initial-branch=main origin.git", { cwd: badRefDir });
      await execp("git init -q --initial-branch=main root", { cwd: badRefDir });
      await execp('git config user.email "t@t" && git config user.name "T"', {
        cwd: root,
        shell: "/bin/bash",
      });
      writeFileSync(path.join(root, "a.txt"), "one\n");
      await execp("git add . && git commit -q -m base", { cwd: root, shell: "/bin/bash" });
      const baseSha2 = (await execp("git rev-parse HEAD", { cwd: root })).stdout.trim();
      await execp(`git remote add origin ${JSON.stringify(origin)} && git push -q -u origin main`, {
        cwd: root,
      });
      await execp(
        `git checkout -qb feature/lens-badref && git push -q -u origin feature/lens-badref`,
        { cwd: root },
      );
      // Create the worktree at the OLD base, then advance the branch tip in
      // repoRoot so the worktree is BEHIND the tip. That forces the gate past
      // the `already-at-tip` early return and onto the ancestry probe.
      await execp(`git worktree add --detach ${JSON.stringify(wt)} ${JSON.stringify(baseSha2)}`, {
        cwd: root,
      });
      writeFileSync(path.join(root, "a.txt"), "one\nadvance\n");
      await execp("git add . && git commit -q -m advance", { cwd: root, shell: "/bin/bash" });
      await execp("git push -q origin feature/lens-badref", { cwd: root });
      // The executor intercepts ANY `git merge-base --is-ancestor` call and
      // rejects with a non-1 code (simulating exit 128 — a git failure, not a
      // proven non-ancestry). The gate must route to `git-failed`, not
      // `diverged`, and must NOT move the tree (fail closed).
      const wtHeadBefore = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();
      assert(wtHeadBefore === baseSha2, "981 reposition: the worktree starts at the old base (behind the tip)");
      const mergeBaseFails = async (cmd: string, o?: { cwd?: string; argv?: string[] }) => {
        if (o?.argv && o.argv[0] === "merge-base") {
          const err = new Error("simulated git merge-base failure (exit 128)") as Error & { code?: number };
          err.code = 128;
          throw err;
        }
        return repositionExec(cmd, o);
      };
      const rBad = await repositionLensFixWorktree(
        mergeBaseFails,
        wt,
        "feature/lens-badref",
        [981],
        "reposition test",
      );
      assert(
        rBad.kind === "git-failed",
        `981 reposition: a merge-base git failure (exit 128) routes to git-failed, not diverged (got ${rBad.kind})`,
      );
      assert(
        "detail" in rBad && rBad.detail.includes("merge-base"),
        "981 reposition: the git-failed detail names the merge-base probe failure",
      );
      const wtHeadAfterBad = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();
      assert(
        wtHeadAfterBad === wtHeadBefore,
        "981 reposition: the tree is NOT moved when merge-base fails (fail closed)",
      );

      // Task 3 (MEDIUM): a merge-base call that dies like a TIMEOUT (killed
      // by its wall-clock bound — no exit code, a signal) is also NOT a
      // proven non-ancestry. `isAncestor` must surface it as `git-failed`
      // (any failure that is not a clean exit-1 is an error), and the tree
      // must not move — fail closed.
      const wtHeadBeforeTo = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();
      const mergeBaseTimesOut = async (cmd: string, o?: { cwd?: string; argv?: string[] }) => {
        if (o?.argv && o.argv[0] === "merge-base") {
          const err = new Error("simulated merge-base timeout (killed by its bound)") as Error & {
            code: number | null;
            killed?: boolean;
            signal?: string;
          };
          err.code = null;
          err.killed = true;
          err.signal = "SIGTERM";
          throw err;
        }
        return repositionExec(cmd, o);
      };
      const rTo = await repositionLensFixWorktree(
        mergeBaseTimesOut,
        wt,
        "feature/lens-badref",
        [981],
        "reposition test",
      );
      assert(
        rTo.kind === "git-failed",
        `981 reposition: a merge-base timeout (killed, no exit code) routes to git-failed (got ${rTo.kind})`,
      );
      const wtHeadAfterTo = (await execp("git rev-parse HEAD", { cwd: wt })).stdout.trim();
      assert(
        wtHeadAfterTo === wtHeadBeforeTo,
        "981 reposition: the tree is NOT moved when merge-base times out (fail closed)",
      );
      console.log("✓ 981 reposition test passed");
    } finally {
      rmSync(badRefDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
