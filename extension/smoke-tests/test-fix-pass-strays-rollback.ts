#!/usr/bin/env bun
/**
 * #1849 — a revert that fails at its commit puts the tree back.
 *
 * `revertPaths` destroys, `commitRevert` runs after it. Before #1849 a commit
 * failure returned `{reason}` with the strays already deleted: the pass parked
 * saying "not reverted" while the files the operator's fixer wrote were gone —
 * the harness destroying work on the way to reporting it had done nothing.
 *
 * The rollback is asserted against the tree, not against the code path: content
 * byte-for-byte (committed AND uncommitted), the untracked stray back from its
 * copy, the index back to what the pass handed over, and HEAD unmoved. A restore
 * that got the files back but left the revert's staging behind is a different tree
 * than the one the pass was given, and the next develop round would commit it.
 */

import { existsSync, readFileSync } from "node:fs";
import { runGit, type GitExec } from "../src/work-develop-git.ts";
import { execp } from "../src/exec.ts";
import { revertFixPassStrays } from "../src/work-driver-fix-pass-strays.ts";
import { git, passTreeAt } from "./lib/adversarial-fix-fixtures.ts";

const real: GitExec = runGit(execp);

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A transport that fails ONLY `commit-tree`, so every destructive call runs and
 *  the commit refuses — the state the rollback exists for. */
const commitFails: GitExec = async (args, opts) => {
  if (args.includes("commit-tree")) throw new Error("simulated commit failure");
  return real(args, opts);
};

console.log("# a failed revert commit restores the tree exactly as the pass left it");
{
  const t = passTreeAt("1846-rollback");
  const before = {
    status: git(t.worktree, "status --porcelain").trim().split("\n").sort().join("\n"),
    head: git(t.worktree, "log -1 --format=%H").trim(),
    tracked: readFileSync(`${t.worktree}/b.txt`, "utf8"),
    created: readFileSync(`${t.worktree}/helper.ts`, "utf8"),
  };
  const res = await revertFixPassStrays({
    git: commitFails,
    worktree: t.worktree,
    // #1849 item 7 — the recorded tree matches the tree under test; every case in
    // this file is about its own rule, and the mismatch/refusal cases are
    // `test-fix-pass-strays-worktree.ts`. Absent here would fail every case on the
    // target gate instead.
    recordedWorktree: t.worktree,
    repoRoot: t.repoRoot,
    issue: 1846,
    workstreamId: "default",
    attempt: 1,
    headBefore: t.headBefore,
    // A modified stray, a tracked path the pass CREATED, and an untracked one —
    // the three roles `revertPaths` treats differently, all in one revert.
    strays: ["b.txt", "helper.ts", "scratch-notes.md"],
    untracked: new Set(["scratch-notes.md"]),
    scratchDir: `${t.repoRoot}/tmp/issue-1846`,
  });
  assert("reason" in res, "the revert refused at the commit");
  if (!("reason" in res)) process.exit(1);
  assert(
    /restored from refs\/pi-rukas\/fix-pass-strays\//.test(res.reason),
    `and the reason says so rather than implying nothing happened (${res.reason.slice(-120)})`,
  );
  assert(
    readFileSync(`${t.worktree}/b.txt`, "utf8") === before.tracked,
    `the MODIFIED stray is byte-identical to its uncommitted pre-revert content, not its committed one (${JSON.stringify(readFileSync(`${t.worktree}/b.txt`, "utf8"))} vs ${JSON.stringify(before.tracked)})`,
  );
  assert(
    existsSync(`${t.worktree}/helper.ts`) &&
      readFileSync(`${t.worktree}/helper.ts`, "utf8") === before.created,
    "the path the pass CREATED is back — `git rm` had deleted it from worktree AND index",
  );
  assert(
    existsSync(`${t.worktree}/scratch-notes.md`),
    "the UNTRACKED stray is back from the copy beside the patch (no commit ever held it)",
  );
  assert(
    git(t.worktree, "log -1 --format=%H").trim() === before.head,
    "HEAD never moved — the commit failed, so there is no revert commit",
  );
  assert(
    git(t.worktree, "status --porcelain").trim().split("\n").sort().join("\n") === before.status,
    `the INDEX is as the pass handed it over, not left with the revert's staging (${JSON.stringify(git(t.worktree, "status --porcelain").trim())} vs ${JSON.stringify(before.status)})`,
  );
}

console.log("# a rollback that cannot finish says so, and names where to recover from");
{
  // Everything after the destructive calls fails: the tree is NOT recoverable by
  // this path, and the operator must be told which artefacts hold the content.
  const t = passTreeAt("1846-rollback-stuck");
  const g: GitExec = async (args, opts) => {
    if (args.includes("commit-tree") || args[0] === "apply")
      throw new Error("simulated failure");
    return real(args, opts);
  };
  const res = await revertFixPassStrays({
    git: g,
    worktree: t.worktree,
    // #1849 item 7 — the recorded tree matches the tree under test; every case in
    // this file is about its own rule, and the mismatch/refusal cases are
    // `test-fix-pass-strays-worktree.ts`. Absent here would fail every case on the
    // target gate instead.
    recordedWorktree: t.worktree,
    repoRoot: t.repoRoot,
    issue: 1846,
    workstreamId: "default",
    attempt: 2,
    headBefore: t.headBefore,
    strays: ["helper.ts"],
    untracked: new Set<string>(),
    scratchDir: `${t.repoRoot}/tmp/issue-1846`,
  });
  assert("reason" in res, "the revert refused");
  if (!("reason" in res)) process.exit(1);
  assert(
    /tree NOT restored/.test(res.reason),
    `and it says the tree was NOT restored rather than claiming it was (${res.reason.slice(-140)})`,
  );
  assert(
    /refs\/pi-rukas\/fix-pass-strays\/1846-default-2/.test(res.reason) &&
      /fix-pass-strays-1846-default-2\.patch/.test(res.reason),
    "naming the preserved ref and the patch as the way to get the content back",
  );
}

if (exit !== 0) console.log(`\n${exit} assertion(s) FAILED`);
else console.log("\nall assertions passed");
process.exit(exit);
