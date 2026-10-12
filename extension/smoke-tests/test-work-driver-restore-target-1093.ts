#!/usr/bin/env bun
/**
 * #1093 review round — one restore-target rule, and no git mutation after a
 * refused checkout. Real git in temp repos; helpers in lib/restore-start-ref-fixtures.ts.
 *   1. refused checkout → no `pull` runs and no `branch -d` runs
 *   2. no start ref recorded → restores to mainline with the explicit note
 *   3. resolveRestoreTarget: no start ref and no mainline → no target (never a guess)
 *   4. a mergedBranch that is not a plain ref is refused before git sees it
 */

import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRestoreTarget, restoreCheckout } from "../src/work-driver-git.ts";
import type { ExecFn } from "../src/worktree.ts";
import { assert, buildRepo, head, realExec, result, shown } from "./lib/restore-start-ref-fixtures.ts";

function recordingExec(calls: string[]): ExecFn {
  return (cmd, opts) => {
    calls.push(shown(cmd, opts));
    return realExec(cmd, opts);
  };
}

// ---- 1. refused checkout performs no further git mutation ------------------
{
  const dir = buildRepo();
  try {
    const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    // main carries a change to tracked.txt that the cycle branch does not have.
    g(["checkout", "-q", "main"]);
    writeFileSync(join(dir, "tracked.txt"), "main change\n");
    g(["commit", "-q", "-am", "main change"]);
    g(["checkout", "-q", "feature/merged"]);
    // The operator's uncommitted edit makes the checkout to main refused.
    writeFileSync(join(dir, "tracked.txt"), "operator edit\n");
    const calls: string[] = [];
    const notes = await restoreCheckout({
      repoRoot: dir,
      mainline: "main",
      mergedBranch: "feature/merged",
      execFn: recordingExec(calls),
      startRef: undefined,
    });
    assert(head(dir) === "feature/merged", "refused: the tree stays where it was");
    assert(
      notes.some((n) => n.includes("repoRoot was NOT restored to main")),
      `refused: the note says the restore did not happen (got ${JSON.stringify(notes)})`,
    );
    assert(
      !calls.some((c) => /\bpull\b/.test(c)),
      `refused: no pull ran after the refused checkout (commands: ${JSON.stringify(calls)})`,
    );
    assert(
      !calls.some((c) => /branch -d/.test(c)),
      "refused: no branch -d ran after the refused checkout",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 2. no start ref → mainline, with the explicit note ---------------------
{
  const dir = buildRepo();
  try {
    const calls: string[] = [];
    const notes = await restoreCheckout({
      repoRoot: dir,
      mainline: "main",
      mergedBranch: undefined,
      execFn: recordingExec(calls),
      startRef: undefined,
    });
    assert(head(dir) === "main", "no start ref: restored to mainline, never the cycle's branch");
    assert(
      notes.includes("start ref was not recorded; restored to main"),
      `no start ref: the explicit note is present (got ${JSON.stringify(notes)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 3. no start ref and no mainline → no target -----------------------------
{
  const dir = buildRepo();
  try {
    const resolved = await resolveRestoreTarget({
      execFn: realExec,
      repoRoot: dir,
      mainline: undefined,
      startRef: undefined,
    });
    assert(resolved.target === undefined, "no target: nothing is guessed");
    assert(
      resolved.notes.includes("start ref was not recorded; no mainline to restore to"),
      `no target: the note says why (got ${JSON.stringify(resolved.notes)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- 4. a non-plain merged branch is refused before git sees it -------------
{
  const dir = buildRepo();
  try {
    const calls: string[] = [];
    const notes = await restoreCheckout({
      repoRoot: dir,
      mainline: "main",
      mergedBranch: "--force",
      execFn: recordingExec(calls),
      startRef: "feature/x",
    });
    assert(
      !calls.some((c) => /branch -d/.test(c)),
      "option-shaped mergedBranch: branch -d is never run",
    );
    assert(
      notes.some((n) => n.startsWith("git branch -d skipped:")),
      `option-shaped mergedBranch: the skip is noted (got ${JSON.stringify(notes)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(result.exit);
