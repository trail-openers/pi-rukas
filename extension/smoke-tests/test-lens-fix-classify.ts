#!/usr/bin/env bun
/**
 * #492 — the lens-fix step can produce nothing stageable, and the cap that
 * fires has to say WHICH cause occurred, with the git evidence.
 *
 * The two causes read identically at the `lens-fix-not-integrated` cap:
 *   (a) the fixer produced no diff — every worktree was clean, OR
 *   (b) a diff existed but integration failed (apply conflict, dirty root, …).
 * They require opposite operator responses, so they cannot be flattened.
 *
 * The classification point is `integrate()`. A no-diff worktree must be
 * reported as such — `empty: true` carrying a `noDiff` map that names the
 * worktree path the operator can inspect directly — while a real integration
 * failure must stay `ok: false` with a reason that names the offending
 * workstream and carries the git error. This test runs `integrate()` against
 * real git for both shapes and asserts they classify apart.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { integrate } from "../src/work-driver-integrate.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Real shell exec, matching the driver's ExecFn contract. */
const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-lensfix-classify-"));

/**
 * A repo with a bare origin, one commit on main, one detached worktree, and a
 * feature branch already existing at baseSha (the commit-pr shape the lens-fix
 * follow-up integration starts from).
 */
async function fixture(name: string) {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  const scratch = path.join(dir, "scratch");
  mkdirSync(scratch, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const { stdout: sha } = await git(repo, ["rev-parse", "HEAD"]);
  const baseSha = sha.trim();
  const wt = path.join(dir, "wt-default");
  await git(repo, ["worktree", "add", "--detach", wt, baseSha]);
  // The feature branch must already exist at baseSha for followup mode
  // (`git checkout <branch>`), which is what lens-fix integration does.
  await git(repo, ["branch", "feature/lensfix", baseSha]);
  return {
    repo,
    scratch,
    baseSha,
    wt,
    branchName: "feature/lensfix",
    worktrees: { default: wt } as Record<string, string>,
  };
}

try {
  // ------------------------------------------------------------------ Case A
  // The fixer wrote nothing: the worktree is clean. `integrate()` in followup
  // mode (no requireAllNonEmpty) must report empty=true AND carry a `noDiff`
  // map naming the worktree path the operator can inspect directly — not a
  // failure, and not a silent skip the way the pre-#492 code did.
  {
    const f = await fixture("nodiff");
    const r = await integrate(realExec, {
      repoRoot: f.repo,
      branchName: f.branchName,
      worktrees: f.worktrees,
      scratchDir: f.scratch,
      commitTitle: "fix(lens): round 1 review findings",
      commitBody: "b",
      mode: "followup",
    });
    assert(
      r.ok && r.empty && r.workstreams.length === 0,
      `A: a clean worktree classifies as 'nothing to integrate', not a failure (got ${r.ok ? (r.empty ? "empty" : "non-empty") : `"${r.reason}"`})`,
    );
    if (r.ok && r.empty) {
      assert(
        r.noDiff && Object.keys(r.noDiff).length === 1 && r.noDiff.default === f.wt,
        `A: the no-diff worktree is named as its ACTUAL path the operator can inspect (expected "${f.wt}", got ${JSON.stringify(r.noDiff)})`,
      );
    }
    // Ground truth: the worktree really is clean, so the classification is
    // honest rather than inferred from an empty patch for other reasons.
    const { stdout: status } = await git(f.wt, ["status", "--porcelain"]);
    assert(status.trim() === "", "A: ground truth — the worktree is genuinely clean");
  }

  // ------------------------------------------------------------------ Case B
  // A diff existed but integration FAILED: the worktree has a real change and
  // it conflicts with the branch. `integrate()` must fail (ok:false), name the
  // offending workstream, carry the git error, and restore repoRoot — the
  // opposite response the operator needs versus Case A.
  {
    const f = await fixture("conflict");
    // Move the feature branch so it diverges from the worktree's base on the
    // same line the worktree edits → a genuine 3-way conflict on apply.
    await git(f.repo, ["checkout", "-B", f.branchName, f.baseSha]);
    writeFileSync(path.join(f.repo, "tracked.txt"), "branch-side change\n");
    await git(f.repo, ["add", "."]);
    await git(f.repo, ["commit", "-q", "-m", "branch moves tracked.txt"]);
    await git(f.repo, ["checkout", "-q", "main"]);
    writeFileSync(path.join(f.wt, "tracked.txt"), "worktree-side change\n");
    const r = await integrate(realExec, {
      repoRoot: f.repo,
      branchName: f.branchName,
      worktrees: f.worktrees,
      scratchDir: f.scratch,
      commitTitle: "fix(lens): round 1 review findings",
      commitBody: "b",
      mode: "followup",
    });
    assert(
      !r.ok,
      `B: a real integration failure classifies as a FAILURE, not 'nothing to integrate' (got ${r.ok ? (r.empty ? "empty" : "non-empty ok") : "ok:false"})`,
    );
    if (!r.ok) {
      // The load-bearing invariants are the classification (ok:false), the
      // offending workstream being named, and repoRoot being restored below.
      // The git stderr wording is not part of integrate()'s contract — do
      // not assert against it.
      assert(
        /default/.test(r.reason),
        `B: the failure names the offending workstream (got "${r.reason}")`,
      );
      assert(r.reason.length > 0, `B: the failure carries a non-empty reason (got "${r.reason}")`);
    }
    // repoRoot must be restored, not left half-applied (the #287 invariant).
    const { stdout: dirt } = await git(f.repo, ["status", "--porcelain"]);
    assert(
      dirt.trim() === "",
      `B: repoRoot is restored after the failed integration (got "${dirt.trim().slice(0, 120)}")`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
