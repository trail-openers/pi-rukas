#!/usr/bin/env bun
/**
 * #287 — always-worktree against REAL git.
 *
 * The sibling test (test-work-driver-always-worktree.ts) records commands and
 * asserts on the call graph. That proves we *ask* git the right things; it
 * cannot prove git *does* the right thing. This file runs the real binary
 * against a throwaway repo with a local bare "origin", so worktree creation,
 * detachment, patch transplant and branch topology are all genuinely
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

  // ---- B: integrate refuses against a dirty repo root --------------------
  writeFileSync(path.join(wt, "feature.txt"), "new feature\n");
  const dirty = await integrate(realExec, {
    repoRoot: repo,
    branchName: setup.branchName,
    baseSha: setup.baseSha,
    worktrees: setup.worktrees,
    scratchDir: scratch,
    commitTitle: "feat: thing",
    commitBody: "Fixes #287",
    mode: "create",
    requireAllNonEmpty: true,
  });
  assert(
    !dirty.ok && /uncommitted changes/.test(dirty.reason),
    "real git: integrate refuses while the operator's file is uncommitted at repo root",
  );
  assert(
    readFileSync(path.join(repo, "operator-wip.txt"), "utf8") === "do not touch me\n",
    "real git: the refusal left the operator's file byte-identical",
  );

  // ---- B: integrate succeeds once the root is clean ----------------------
  rmSync(path.join(repo, "operator-wip.txt"));
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
  });
  assert(ok.ok && !ok.empty, `real git: integrate consolidated (${JSON.stringify(ok)})`);

  {
    const { stdout } = await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert(
      stdout.trim() === setup.branchName,
      "real git: repo root now sits on the feature branch",
    );
  }
  {
    // The untracked file created in the WORKTREE must have landed in the
    // commit at repoRoot. `git diff HEAD` alone used to miss untracked files.
    const { stdout } = await git(repo, ["show", "--name-only", "--format=", "HEAD"]);
    assert(
      stdout.includes("feature.txt"),
      "real git: the worktree's untracked new file landed in the integration commit",
    );
  }
  {
    const { stdout } = await git(repo, ["log", "--format=%s", "-1"]);
    assert(stdout.trim() === "feat: thing", "real git: commit title is the templated one");
  }
  {
    // Branch topology: exactly one commit ahead of the base it was cut from.
    const { stdout } = await git(repo, ["rev-list", "--count", `${setup.baseSha}..HEAD`]);
    assert(stdout.trim() === "1", "real git: branch is exactly one commit ahead of baseSha");
  }
  {
    const { stdout } = await git(originDir, ["rev-parse", "--verify", setup.branchName]);
    assert(stdout.trim().length === 40, "real git: branch was pushed to origin");
  }

  // ---- C: follow-up integration (the lens-fix path) ----------------------
  writeFileSync(path.join(wt, "feature.txt"), "new feature\nfixed\n");
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

console.log(`\nexit ${exit}`);
process.exit(exit);
