#!/usr/bin/env bun
/**
 * #654 — sweepBranchHolders: detect branch-held-by-worktree, remove clean
 * holders, refuse dirty ones via DirtyWorktreeError.
 *
 * Census: 2 cycles parked on `fatal: '<branch>' is already used by worktree
 * at '<path>'` when `integrate()` followed up with `git checkout <branch>`
 * in repoRoot while a parked cycle's leftover worktree still held the branch.
 *
 * `sweepBranchHolders` runs before that checkout: a clean holder is removed
 * (the checkout then succeeds), a dirty holder throws `DirtyWorktreeError`
 * naming the absolute path (the #475 convention — never force-remove
 * unrecoverable work).
 *
 * Verified with real git (the load-bearing evidence) and with an injected
 * exec (the ordering contract: the sweep runs BEFORE the checkout inside
 * `integrate()` followup mode).
 */

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { integrate } from "../src/work-driver-integrate.ts";
import { DirtyWorktreeError, sweepBranchHolders } from "../src/worktree.ts";
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

const realExec: ExecFn = async (cmd, o) => {
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};
const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });

/** A minimal repo with a committed base on main. */
async function fixture(name: string): Promise<{ repo: string; baseSha: string }> {
  const repo = path.join(root, name);
  await import("node:fs/promises").then((fs) => fs.mkdir(repo, { recursive: true }));
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const { stdout } = await git(repo, ["rev-parse", "HEAD"]);
  return { repo, baseSha: stdout.trim() };
}

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-sweep-branch-"));

/** Set up a worktree holding the feature branch (repoRoot stays on main). */
async function setupHolder(repo: string, baseSha: string) {
  await git(repo, ["branch", "-q", "feature/issue-654-task-d", baseSha]);
  const holder = path.join(repo, ".worktrees", "issue-654-old");
  await git(repo, ["worktree", "add", "-q", holder, "feature/issue-654-task-d"]);
  return holder;
}

try {
  // ------------- real git: a clean holder is removed, the branch is free
  {
    const { repo, baseSha } = await fixture("sweep-clean");
    const holder = await setupHolder(repo, baseSha);
    const { stdout: listBefore } = await git(repo, ["worktree", "list", "--porcelain"]);
    assert(
      listBefore.includes("branch refs/heads/feature/issue-654-task-d"),
      "fixture: the branch is held by a worktree (sweep precondition)",
    );

    const removed = await sweepBranchHolders(realExec, repo, "feature/issue-654-task-d");
    assert(removed === true, "sweep: a clean holder is removed and the sweep reports it");
    const { stdout: listAfter } = await git(repo, ["worktree", "list", "--porcelain"]);
    assert(
      !listAfter.includes("branch refs/heads/feature/issue-654-task-d"),
      "sweep: the holder is gone — the branch is free for the checkout",
    );
    // The checkout that previously died with the fatal now succeeds.
    await git(repo, ["checkout", "-q", "feature/issue-654-task-d"]);
    const { stdout: headRef } = await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    assert(
      headRef.trim() === "feature/issue-654-task-d",
      "the checkout succeeds after the sweep — the fatal is mechanically resolved",
    );
  }

  // ------------------- real git: a DIRTY holder refuses (DirtyWorktreeError)
  {
    const { repo, baseSha } = await fixture("sweep-dirty");
    const holder = await setupHolder(repo, baseSha);
    writeFileSync(path.join(holder, "a.txt"), "base\nuncommitted work in the holder\n");

    let dirty: DirtyWorktreeError | undefined;
    try {
      await sweepBranchHolders(realExec, repo, "feature/issue-654-task-d");
    } catch (err) {
      if (err instanceof DirtyWorktreeError) dirty = err;
      else throw err;
    }
    assert(dirty !== undefined, "sweep: a dirty holder is REFUSED, not force-removed (#475)");
    assert(
      dirty?.message.includes(holder) === true,
      "the refusal names the ABSOLUTE holder path so the operator can inspect it",
    );
    const { stdout: listAfter } = await git(repo, ["worktree", "list", "--porcelain"]);
    assert(
      listAfter.includes("branch refs/heads/feature/issue-654-task-d"),
      "the dirty holder survives the refusal — nothing was destroyed",
    );
  }

  // ------------------- real git: no worktree holder — the no-op fast path
  {
    const { repo, baseSha } = await fixture("sweep-free");
    // The branch exists and is checked out at repoRoot, but no worktree holds it.
    await git(repo, ["checkout", "-q", "-b", "feature/issue-654-task-d", baseSha]);
    const removed = await sweepBranchHolders(realExec, repo, "feature/issue-654-task-d");
    assert(
      removed === false,
      "sweep: a branch held only by repoRoot is a no-op (returns false)",
    );
  }

  // ------------------- real git: an unrelated worktree is never touched
  {
    const { repo, baseSha } = await fixture("sweep-other");
    const holder = await setupHolder(repo, baseSha);
    const other = path.join(repo, ".worktrees", "issue-999-other");
    await git(repo, ["worktree", "add", "-q", "--detach", other, baseSha]);
    const removed = await sweepBranchHolders(realExec, repo, "feature/issue-654-task-d");
    assert(removed === true, "sweep: removes the target branch's holder");
    const { stdout: listAfter } = await git(repo, ["worktree", "list", "--porcelain"]);
    assert(listAfter.includes(other), "a worktree holding a DIFFERENT ref is untouched");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------ injected-exec cases

function recorder(overrides: Record<string, string>) {
  const calls: Array<{ cmd: string; cwd: string }> = [];
  const execFn: ExecFn = async (cmd, o) => {
    calls.push({ cmd, cwd: o?.cwd ?? "" });
    for (const [prefix, stdout] of Object.entries(overrides)) {
      if (cmd.startsWith(prefix)) {
        if (stdout.startsWith("!THROW!")) throw new Error(stdout.slice(7));
        return { stdout };
      }
    }
    return { stdout: "" };
  };
  return { calls, execFn };
}

const REPO2 = "/repo-sweep";
const HOLDER = path.join(REPO2, ".worktrees", "issue-654-old");

// ------- stub: clean holder removed, sweep returns true
{
  const { calls, execFn } = recorder({
    "git worktree list --porcelain": [
      `worktree ${REPO2}`,
      "HEAD abc123",
      "branch refs/heads/main",
      `worktree ${HOLDER}`,
      "HEAD def456",
      "branch refs/heads/feature/issue-654-task-d",
      "",
    ].join("\n"),
    "git rev-parse --verify": "\n",
    "git status --porcelain": "\n",
    "git rev-list --count": "0\n",
  });
  const removed = await sweepBranchHolders(execFn, REPO2, "feature/issue-654-task-d");
  assert(removed === true, "stub: clean holder removed, sweep returns true");
  assert(
    calls.some((c) => c.cmd.startsWith("git worktree remove ") && c.cmd.includes(HOLDER)),
    "stub: the removal targets the HOLDER path, not repoRoot",
  );
}

// ------- stub: dirty holder throws DirtyWorktreeError with the path
{
  const { execFn } = recorder({
    "git worktree list --porcelain": [
      `worktree ${HOLDER}`,
      "HEAD def456",
      "branch refs/heads/feature/issue-654-task-d",
      "",
    ].join("\n"),
    "git rev-parse --verify": "\n",
    "git status --porcelain": " M src/wip.ts\n",
    "git rev-list --count": "0\n",
  });
  let dirty: DirtyWorktreeError | undefined;
  try {
    await sweepBranchHolders(execFn, REPO2, "feature/issue-654-task-d");
  } catch (err) {
    if (err instanceof DirtyWorktreeError) dirty = err;
    else throw err;
  }
  assert(dirty !== undefined, "stub: dirty holder throws DirtyWorktreeError");
  assert(dirty?.finding.path === HOLDER, "the finding carries the holder's absolute path");
}

// ------- stub: unreadable worktree list degrades to the no-op path
{
  const { execFn } = recorder({
    "git worktree list --porcelain": "!THROW!fatal: not a git repository",
  });
  const removed = await sweepBranchHolders(execFn, REPO2, "feature/issue-654-task-d");
  assert(
    removed === false,
    "stub: unreadable list degrades to 'no holder' — checkout then fails with the raw git error",
  );
}

// ------------------- integrate() wiring: sweep runs BEFORE the checkout
{
  const { execFn } = recorder({
    "git worktree list --porcelain": "\n",
    "git status --porcelain": "\n",
    "git symbolic-ref": "main\n",
    "git diff --cached --name-only": "",
    "git rev-list --count": "0\n",
  });
  const orderingCalls: string[] = [];
  const recordingExec: ExecFn = async (cmd, o) => {
    orderingCalls.push(cmd);
    return execFn(cmd, o);
  };
  await integrate(recordingExec, {
    repoRoot: "/repo-integrate",
    branchName: "feature/issue-654-task-d",
    worktrees: {},
    scratchDir: "/scratch",
    commitTitle: "t",
    commitBody: "b",
    mode: "followup",
  });
  const listIdx = orderingCalls.findIndex((c) => c === "git worktree list --porcelain");
  const checkoutIdx = orderingCalls.findIndex((c) =>
    c.startsWith(`git checkout "feature/issue-654-task-d"`),
  );
  assert(
    listIdx !== -1 && checkoutIdx !== -1 && listIdx < checkoutIdx,
    "integrate() followup: the branch-holder sweep runs BEFORE the checkout that was dying on the fatal",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
