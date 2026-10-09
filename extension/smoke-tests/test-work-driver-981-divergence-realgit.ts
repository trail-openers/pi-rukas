#!/usr/bin/env bun
/**
 * #981 — round-2 lens-fix divergence and pick-range regression against REAL git.
 *
 * Reproduces the 6b3c3bf→b78c546 vs 6b3c3bf→1c9bb39 divergence shape from
 * issue #978: the branch advances by an integrated round-1 fix while the
 * worktree stays at the old base. A round-2 fix built on the stale worktree
 * must still integrate cleanly (dedup skips round-1, lands only round-2).
 *
 * Deliberately NOT named `*-live.ts` — same convention as the sibling
 * test-work-driver-integrate-realgit.ts.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import { integrate } from "../src/work-driver-integrate.ts";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
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
// Honours the argv form (cmd = executable, argv = arguments — #1005) for the
// reposition gate's argv-form git calls.
const realExec: ExecFn = async (cmd, o) => {
  if (o?.argv) {
    const { stdout } = await execFileP(cmd, o.argv, {
      cwd: o.cwd,
      maxBuffer: o.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  }
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

// ---- G: #981 — round-2 lens-fix divergence (the 978 shape) ----------------
// Reproduces the 6b3c3bf→b78c546 vs 6b3c3bf→1c9bb39 divergence: the branch
// advances by an integrated round-1 fix while the worktree stays at the old
// base. A round-2 fix built on the stale worktree must still integrate
// cleanly (dedup skips round-1, lands only round-2).
{
  const root5 = mkdtempSync(path.join(tmpdir(), "pi-ens-981-"));
  const origin5 = path.join(root5, "origin.git");
  const repo5 = path.join(root5, "repo");
  const scratch5 = path.join(root5, "scratch");
  mkdirSync(scratch5, { recursive: true });

  try {
    await execFileP("git", ["init", "--bare", "--initial-branch=main", origin5]);
    await execFileP("git", ["init", "--initial-branch=main", repo5]);
    await git(repo5, ["config", "user.email", "t@example.com"]);
    await git(repo5, ["config", "user.name", "T"]);
    writeFileSync(path.join(repo5, "docs.txt"), "line1\nline2\nline3\n");
    writeFileSync(path.join(repo5, "note.txt"), "alpha\n");
    await git(repo5, ["add", "."]);
    await git(repo5, ["commit", "-q", "-m", "base"]);
    await git(repo5, ["remote", "add", "origin", origin5]);
    await git(repo5, ["push", "-q", "-u", "origin", "main"]);

    const s5 = await mechanizedBranchSetup(realExec, repo5, 981, [981], [], "981 round-2");
    const wt5 = s5.worktrees.default ?? "";
    assert(existsSync(wt5), "981 G: worktree exists");

    // Round 1: commit + integrate (create mode creates the branch).
    writeFileSync(path.join(wt5, "docs.txt"), "line1\nline2\nline3\nround-1 fix\n");
    await git(wt5, ["add", "."]);
    await git(wt5, ["commit", "-q", "-m", "fix(lens): round 1"]);
    const f1 = await integrate(realExec, {
      repoRoot: repo5,
      branchName: s5.branchName,
      baseSha: s5.baseSha,
      worktrees: s5.worktrees,
      scratchDir: scratch5,
      commitTitle: "fix(lens): round 1",
      commitBody: "b1",
      mode: "create",
    });
    assert(f1.ok && !f1.empty, "981 G: round-1 integration landed");
    const tip1 = (await git(repo5, ["rev-parse", "HEAD"])).stdout.trim();
    assert(tip1 !== s5.baseSha, "981 G: branch tip moved past base (divergence shape)");

    // Worktree back to old base + round-1 (stale shape): the worktree now
    // holds the previous round's fix commit, which reached the branch as a
    // DIFFERENT (patch-applied) commit with the same patch — the NORMAL
    // #981 round-2+ shape. The branch was advanced via `git apply --3way`
    // (not `git cherry-pick`), so the worktree commit and the branch commit
    // are patch-equivalent but have DIFFERENT SHAs (the committer/date/
    // parent differ). `git cherry` detects this via patch-id.
    await git(wt5, ["checkout", "-q", "--detach", s5.baseSha]);
    const r1Sha = (await git(wt5, ["rev-parse", "HEAD"])).stdout.trim();
    await git(wt5, ["merge", "--ff-only", "-q", r1Sha]);
    const preCherrySha = (await git(wt5, ["rev-parse", "HEAD"])).stdout.trim();
    const branchTipPre = (await git(repo5, ["rev-parse", s5.branchName])).stdout.trim();
    assert(
      preCherrySha !== branchTipPre,
      "981 G: worktree SHA differs from branch tip (patch-applied, not cherry-pick)",
    );

    // Reposition succeeds: every worktree commit has a patch-equivalent on
    // the tip (landed via cherry or patch-applied), so the gate moves the
    // clean tree to the tip instead of parking (previously this case parked
    // as `diverged`).
    const rep = await repositionLensFixWorktree(realExec, wt5, s5.branchName, [981], "981 round-2");
    assert(
      rep.kind === "repositioned",
      `981 G: reposition guard moved the worktree to the tip (got ${rep.kind}${
        rep.kind === "repositioned" ? ` movedByPatchEquivalence=${rep.movedByPatchEquivalence}` : ""
      })`,
    );
    const repHead = (await git(wt5, ["rev-parse", "HEAD"])).stdout.trim();
    const branchTipNow = (await git(repo5, ["rev-parse", s5.branchName])).stdout.trim();
    assert(repHead === branchTipNow, "981 G: worktree HEAD is the branch tip after reposition");

    // Round 2: commit in the repositioned worktree (now at the branch tip).
    writeFileSync(path.join(wt5, "note.txt"), "alpha\nbeta\n");
    await git(wt5, ["add", "."]);
    await git(wt5, ["commit", "-q", "-m", "fix(lens): round 2"]);
    const r2Sha = (await git(wt5, ["rev-parse", "HEAD"])).stdout.trim();
    assert(r2Sha.length === 40, "981 G: round-2 commit captured");

    // Round-2 integration: lands cleanly onto the branch (no conflict).
    const f2 = await integrate(realExec, {
      repoRoot: repo5,
      branchName: s5.branchName,
      baseSha: s5.baseSha,
      worktrees: s5.worktrees,
      scratchDir: scratch5,
      commitTitle: "fix(lens): round 2",
      commitBody: "b2",
      mode: "followup",
    });
    assert(f2.ok && !f2.empty, "981 G: round-2 integration landed cleanly");
    if (f2.ok && !f2.empty) {
      assert(
        (await git(repo5, ["show", "HEAD:note.txt"])).stdout.includes("beta"),
        "981 G: round-2 content on branch tip",
      );
      const ahead = (
        await git(repo5, ["rev-list", "--count", `${s5.baseSha}..HEAD`])
      ).stdout.trim();
      assert(ahead === "2", `981 G: branch has exactly r1+r2 (got ${ahead} — r1 NOT re-picked)`);
      const ref = (await git(repo5, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
      assert(ref === s5.branchName, `981 G: repoRoot on feature branch (got '${ref}')`);
      const dirty = (await git(repo5, ["status", "--porcelain"])).stdout
        .split("\n")
        .filter((l) => l.trim());
      assert(dirty.length === 0, "981 G: repoRoot clean after round-2");
    }
    // The cherry-landed move traced the SHA it moved from.
    assert(rep.fromSha === preCherrySha, "981 G: reposition result traces the moved-from SHA");
    console.log("✓ 981 G: round-2 lens-fix cherry-landed reposition test passed");
  } finally {
    rmSync(root5, { recursive: true, force: true });
  }
}

// ---- H: #981 — pick-range regression (no reposition) ----------------------
// Same divergence shape as G, but WITHOUT calling repositionLensFixWorktree.
// The integration must still land cleanly because the tree-hash dedup in
// cherryPickWorkstreams skips the already-integrated round-1 commit and
// picks only the new round-2 commit. This guards against a regression where
// the pick range (baseSha..worktree-HEAD) re-picks round-1.
{
  const root6 = mkdtempSync(path.join(tmpdir(), "pi-ens-981b-"));
  const origin6 = path.join(root6, "origin.git");
  const repo6 = path.join(root6, "repo");
  const scratch6 = path.join(root6, "scratch");
  mkdirSync(scratch6, { recursive: true });

  try {
    await execFileP("git", ["init", "--bare", "--initial-branch=main", origin6]);
    await execFileP("git", ["init", "--initial-branch=main", repo6]);
    await git(repo6, ["config", "user.email", "t@example.com"]);
    await git(repo6, ["config", "user.name", "T"]);
    writeFileSync(path.join(repo6, "docs.txt"), "line1\nline2\nline3\n");
    writeFileSync(path.join(repo6, "note.txt"), "alpha\n");
    await git(repo6, ["add", "."]);
    await git(repo6, ["commit", "-q", "-m", "base"]);
    await git(repo6, ["remote", "add", "origin", origin6]);
    await git(repo6, ["push", "-q", "-u", "origin", "main"]);

    const s6 = await mechanizedBranchSetup(realExec, repo6, 982, [982], [], "981b");
    const wt6 = s6.worktrees.default ?? "";

    // Round 1: commit + integrate (create mode).
    writeFileSync(path.join(wt6, "docs.txt"), "line1\nline2\nline3\nround-1 fix\n");
    await git(wt6, ["add", "."]);
    await git(wt6, ["commit", "-q", "-m", "fix(lens): round 1"]);
    const r1Sha = (await git(wt6, ["rev-parse", "HEAD"])).stdout.trim();
    const f1 = await integrate(realExec, {
      repoRoot: repo6,
      branchName: s6.branchName,
      baseSha: s6.baseSha,
      worktrees: s6.worktrees,
      scratchDir: scratch6,
      commitTitle: "fix(lens): round 1",
      commitBody: "b1",
      mode: "create",
    });
    assert(f1.ok && !f1.empty, "981b: round-1 integration landed");

    // Stale worktree: base + round-1, then round-2.
    await git(wt6, ["checkout", "-q", "--detach", s6.baseSha]);
    await git(wt6, ["merge", "--ff-only", "-q", r1Sha]);
    writeFileSync(path.join(wt6, "note.txt"), "alpha\nbeta\n");
    await git(wt6, ["add", "."]);
    await git(wt6, ["commit", "-q", "-m", "fix(lens): round 2"]);

    // Integration WITHOUT reposition.
    const f2 = await integrate(realExec, {
      repoRoot: repo6,
      branchName: s6.branchName,
      baseSha: s6.baseSha,
      worktrees: s6.worktrees,
      scratchDir: scratch6,
      commitTitle: "fix(lens): round 2",
      commitBody: "b2",
      mode: "followup",
    });
    assert(f2.ok && !f2.empty, "981b: round-2 integration landed");
    if (f2.ok && !f2.empty) {
      const ahead = (
        await git(repo6, ["rev-list", "--count", `${s6.baseSha}..HEAD`])
      ).stdout.trim();
      assert(ahead === "2", `981b: branch has exactly r1+r2 (got ${ahead} — r1 dedup-skipped)`);
      const docs = (await git(repo6, ["show", "HEAD:docs.txt"])).stdout;
      assert(
        docs.includes("round-1 fix") && !docs.includes("round-1 fix\nround-1 fix"),
        "981b: r1 content once",
      );
      assert(
        (await git(repo6, ["show", "HEAD:note.txt"])).stdout.includes("beta"),
        "981b: r2 content landed",
      );
    }
    console.log("✓ 981b: pick-range regression test passed");
  } finally {
    rmSync(root6, { recursive: true, force: true });
  }
}

// ---- I: #981 — unlanded work in the worktree (r1 NOT on the branch) ------
// The worktree holds base+r1 where r1 is genuinely un-landed (not on the
// branch — no patch-equivalent on the tip). The gate must park (unlanded)
// and back up the worktree to a ref; nothing moves.
{
  const rootI = mkdtempSync(path.join(tmpdir(), "pi-ens-981i-"));
  const originI = path.join(rootI, "origin.git");
  const repoI = path.join(rootI, "repo");
  const scratchI = path.join(rootI, "scratch");
  mkdirSync(scratchI, { recursive: true });

  try {
    await execFileP("git", ["init", "--bare", "--initial-branch=main", originI]);
    await execFileP("git", ["init", "--initial-branch=main", repoI]);
    await git(repoI, ["config", "user.email", "t@example.com"]);
    await git(repoI, ["config", "user.name", "T"]);
    writeFileSync(path.join(repoI, "docs.txt"), "line1\nline2\nline3\n");
    await git(repoI, ["add", "."]);
    await git(repoI, ["commit", "-q", "-m", "base"]);
    await git(repoI, ["remote", "add", "origin", originI]);
    await git(repoI, ["push", "-q", "-u", "origin", "main"]);

    const sI = await mechanizedBranchSetup(realExec, repoI, 981, [981], [], "981 unlanded");
    const wtI = sI.worktrees.default ?? "";

    // Create + push the branch (mirror G: the branch must exist on the
    // remote for the gate to resolve its tip).
    await git(repoI, ["checkout", "-q", "-b", sI.branchName]);
    await git(repoI, ["push", "-q", "origin", sI.branchName]);

    // Commit r1 in the worktree, then advance the branch with a DIFFERENT
    // commit (so the worktree's r1 is NOT on the branch — no patch-
    // equivalent exists on the tip).
    writeFileSync(path.join(wtI, "docs.txt"), "line1\nline2\nline3\nunlanded r1\n");
    await git(wtI, ["add", "."]);
    await git(wtI, ["commit", "-q", "-m", "fix(lens): round 1"]);
    const r1Sha = (await git(wtI, ["rev-parse", "HEAD"])).stdout.trim();

    // Advance the branch with a different commit (not a cherry-pick of r1).
    writeFileSync(path.join(repoI, "note.txt"), "note content\n");
    await git(repoI, ["add", "."]);
    await git(repoI, ["commit", "-q", "-m", "advance branch"]);
    await git(repoI, ["push", "-q", "origin", sI.branchName]);

    // Reposition should park as unlanded (r1 is NOT on the branch).
    const repI = await repositionLensFixWorktree(
      realExec,
      wtI,
      sI.branchName,
      [981],
      "981 unlanded",
    );
    assert(
      repI.kind === "unlanded" || repI.kind === "diverged",
      `981 I: reposition guard detected unlanded work (got ${repI.kind})`,
    );
    assert(
      repI.kind === "unlanded" || repI.kind === "diverged" ? repI.backupRef !== undefined : false,
      "981 I: unlanded worktree has a backup ref",
    );
    // The worktree is NOT moved (still at r1).
    const wtHeadI = (await git(wtI, ["rev-parse", "HEAD"])).stdout.trim();
    assert(wtHeadI === r1Sha, "981 I: worktree was not moved (still at r1)");
    console.log("✓ 981 I: unlanded worktree test passed");
  } finally {
    rmSync(rootI, { recursive: true, force: true });
  }
}

// ---- J: #981 — local branch ref ahead of stale origin ref ------------------
// The local branch ref is ahead of the origin ref (a local commit has not
// been pushed). Tip selection must take the local ref (the descendant).
{
  const rootJ = mkdtempSync(path.join(tmpdir(), "pi-ens-981j-"));
  const originJ = path.join(rootJ, "origin.git");
  const repoJ = path.join(rootJ, "repo");
  const scratchJ = path.join(rootJ, "scratch");
  mkdirSync(scratchJ, { recursive: true });

  try {
    await execFileP("git", ["init", "--bare", "--initial-branch=main", originJ]);
    await execFileP("git", ["init", "--initial-branch=main", repoJ]);
    await git(repoJ, ["config", "user.email", "t@example.com"]);
    await git(repoJ, ["config", "user.name", "T"]);
    writeFileSync(path.join(repoJ, "docs.txt"), "line1\n");
    await git(repoJ, ["add", "."]);
    await git(repoJ, ["commit", "-q", "-m", "base"]);
    await git(repoJ, ["remote", "add", "origin", originJ]);
    await git(repoJ, ["push", "-q", "-u", "origin", "main"]);

    const sJ = await mechanizedBranchSetup(realExec, repoJ, 981, [981], [], "981 local-tip");
    const wtJ = sJ.worktrees.default ?? "";

    // Create + push the branch (mirror G: the branch must exist on the
    // remote for the gate to resolve its tip).
    await git(repoJ, ["checkout", "-q", "-b", sJ.branchName]);
    await git(repoJ, ["push", "-q", "origin", sJ.branchName]);

    // Commit on the local branch (not pushed to origin).
    writeFileSync(path.join(repoJ, "docs.txt"), "line1\nlocal advance\n");
    await git(repoJ, ["add", "."]);
    await git(repoJ, ["commit", "-q", "-m", "local advance"]);
    const localTip = (await git(repoJ, ["rev-parse", sJ.branchName])).stdout.trim();
    const originTip = (await git(repoJ, ["rev-parse", `origin/${sJ.branchName}`])).stdout.trim();
    assert(localTip !== originTip, "981 J: local ref is ahead of origin ref");

    // Move the worktree back to the old base.
    await git(wtJ, ["checkout", "-q", "--detach", sJ.baseSha]);

    // Reposition should use the local tip (the descendant of origin tip).
    const repJ = await repositionLensFixWorktree(
      realExec,
      wtJ,
      sJ.branchName,
      [981],
      "981 local-tip",
    );
    assert(
      repJ.kind === "repositioned" && !repJ.movedByPatchEquivalence,
      `981 J: reposition uses the local (ahead) tip (got ${repJ.kind})`,
    );
    const wtHeadJ = (await git(wtJ, ["rev-parse", "HEAD"])).stdout.trim();
    assert(wtHeadJ === localTip, "981 J: worktree is at the local tip after reposition");
    console.log("✓ 981 J: local-branch-ahead-of-origin test passed");
  } finally {
    rmSync(rootJ, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
