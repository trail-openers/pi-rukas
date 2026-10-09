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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
import { integrate } from "../src/work-driver-integrate.ts";
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

    // Worktree back to old base + round-1 (stale shape).
    await git(wt5, ["checkout", "-q", "--detach", s5.baseSha]);
    const r1Sha = (await git(wt5, ["rev-parse", "HEAD"])).stdout.trim();
    await git(wt5, ["merge", "--ff-only", "-q", r1Sha]);

    // Round 2: commit in stale worktree.
    writeFileSync(path.join(wt5, "note.txt"), "alpha\nbeta\n");
    await git(wt5, ["add", "."]);
    await git(wt5, ["commit", "-q", "-m", "fix(lens): round 2"]);
    const r2Sha = (await git(wt5, ["rev-parse", "HEAD"])).stdout.trim();
    assert(r2Sha.length === 40, "981 G: round-2 commit captured");

    // Reposition fails (worktree diverged from branch tip).
    const rep = await repositionLensFixWorktree(realExec, wt5, s5.branchName, [981], "981 round-2");
    assert(rep.kind === "diverged" || rep.kind === "unlanded", `981 G: reposition guard detected unsafe state (${rep.kind})`);

    // Round-2 integration: dedup skips round-1, lands only round-2.
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
    assert(f2.ok && !f2.empty, `981 G: round-2 integration landed cleanly`);
    if (f2.ok && !f2.empty) {
      assert(
        (await git(repo5, ["show", "HEAD:note.txt"])).stdout.includes("beta"),
        "981 G: round-2 content on branch tip",
      );
      const ahead = (await git(repo5, ["rev-list", "--count", `${s5.baseSha}..HEAD`])).stdout.trim();
      assert(ahead === "2", `981 G: branch has exactly r1+r2 (got ${ahead} — r1 NOT re-picked)`);
      const ref = (await git(repo5, ["symbolic-ref", "--quiet", "--short", "HEAD"])).stdout.trim();
      assert(ref === s5.branchName, `981 G: repoRoot on feature branch (got '${ref}')`);
      const dirty = (await git(repo5, ["status", "--porcelain"])).stdout
        .split("\n")
        .filter((l) => l.trim());
      assert(dirty.length === 0, `981 G: repoRoot clean after round-2`);
    }
    console.log("✓ 981 G: round-2 lens-fix divergence test passed");
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
    assert(f2.ok && !f2.empty, `981b: round-2 integration landed`);
    if (f2.ok && !f2.empty) {
      const ahead = (await git(repo6, ["rev-list", "--count", `${s6.baseSha}..HEAD`])).stdout.trim();
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

console.log(`\nexit ${exit}`);
process.exit(exit);
