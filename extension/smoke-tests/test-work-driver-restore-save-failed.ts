#!/usr/bin/env bun
/**
 * #1258 — a failed save of the discarded state is not "nothing to save", and
 * the tree is not reset after one.
 *
 * Before: `preserveDiscardedState` returned `undefined` for both, so the
 * restores went on to `reset --hard` / `checkout --force` (or the abort
 * path's mixed reset + stash) and threw away work that existed nowhere else.
 *
 *   1. the three save results: saved (with a path), nothing, failed (naming
 *      the git argv and its stderr);
 *   2. real git: a failed save leaves the tree byte-identical — HEAD, index
 *      (stages included), status, file contents — for both restores, and the
 *      claim names the failure and the tree's absolute path;
 *   3. real git, through a caller: integrate()'s cherry-pick conflict with a
 *      failed save reports it in the failure reason and leaves the conflict
 *      in place rather than resetting it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import { integrate } from "../src/work-driver-integrate.ts";
import { preserveDiscardedState } from "../src/work-driver-restore-save.ts";
import {
  restoreClaim,
  restoreRootToRefPreserving,
  verifiedRestoreRoot,
} from "../src/work-driver-restore.ts";
import type { ExecFn } from "../src/worktree.ts";
import { assert, realExec, result, shown } from "./lib/restore-start-ref-fixtures.ts";

const g = (dir: string, args: string[]) =>
  execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A real-git executor that fails the save's `git diff`, recording every command. */
function failingSave(calls: string[]): ExecFn {
  return async (cmd, opts) => {
    calls.push(shown(cmd, opts));
    if (opts?.argv?.length === 1 && opts.argv[0] === "diff") {
      throw Object.assign(new Error("Command failed: git diff"), {
        stderr: "fatal: unable to read index (injected)",
      });
    }
    return realExec(cmd, opts);
  };
}

const DESTRUCTIVE = /reset|checkout|stash|clean/;

/** Everything a reset could change: HEAD, index stages, status, file bytes. */
function snapshot(dir: string): string {
  const files = readdirSync(dir)
    .filter((f) => f !== ".git")
    .sort()
    .map((f) => `${f}=${readFileSync(join(dir, f), "utf8")}`);
  return JSON.stringify({
    head: g(dir, ["rev-parse", "HEAD"]),
    ref: g(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    index: g(dir, ["ls-files", "-s"]),
    status: g(dir, ["status", "--porcelain=v2", "-uall"]),
    cherry: existsSync(join(dir, ".git", "CHERRY_PICK_HEAD")),
    files,
  });
}

/** A repo mid-cherry-pick-conflict (UU), plus a staged new file, an unstaged edit and an untracked file. */
function conflictedRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "issue67-root-"));
  g(dir, ["init", "-q", "-b", "main"]);
  g(dir, ["config", "user.name", "t"]);
  g(dir, ["config", "user.email", "t@t"]);
  writeFileSync(join(dir, "shared.txt"), "base\n");
  writeFileSync(join(dir, "other.txt"), "other\n");
  g(dir, ["add", "-A"]);
  g(dir, ["commit", "-q", "-m", "base"]);
  g(dir, ["checkout", "-q", "-b", "b"]);
  writeFileSync(join(dir, "shared.txt"), "from b\n");
  g(dir, ["commit", "-q", "-am", "b"]);
  g(dir, ["checkout", "-q", "-b", "a", "main"]);
  writeFileSync(join(dir, "shared.txt"), "from a\n");
  g(dir, ["commit", "-q", "-am", "a"]);
  try {
    g(dir, ["cherry-pick", "b"]);
  } catch {
    // the conflict is the point
  }
  writeFileSync(join(dir, "new.txt"), "staged new\n");
  g(dir, ["add", "new.txt"]);
  writeFileSync(join(dir, "other.txt"), "unstaged edit\n");
  writeFileSync(join(dir, "untracked.txt"), "untracked\n");
  return dir;
}

// ---- 1. the three save results --------------------------------------------
{
  const dir = conflictedRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue67-scratch-"));
  try {
    const saved = await preserveDiscardedState(realExec, dir, scratch, "t");
    assert(
      saved.kind === "saved" && readFileSync(saved.path, "utf8").includes("unstaged edit"),
      `save: a dirty root is saved to a file holding its diff (got ${JSON.stringify(saved)})`,
    );
    const failed = await preserveDiscardedState(failingSave([]), dir, scratch, "t");
    assert(
      failed.kind === "failed" &&
        failed.error.includes("`git diff` failed") &&
        failed.error.includes("unable to read index"),
      `save: a failed read is "failed", naming the argv and git's stderr (got ${JSON.stringify(failed)})`,
    );
    g(dir, ["cherry-pick", "--abort"]);
    g(dir, ["reset", "-q", "--hard"]);
    rmSync(join(dir, "untracked.txt"));
    rmSync(join(dir, "new.txt"), { force: true });
    const nothing = await preserveDiscardedState(realExec, dir, scratch, "t");
    assert(
      nothing.kind === "nothing",
      `save: a clean root is "nothing" (got ${JSON.stringify(nothing)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- 2. a failed save leaves the tree byte-identical, for both restores ----
for (const which of ["verifiedRestoreRoot", "restoreRootToRefPreserving"] as const) {
  const dir = conflictedRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue67-scratch-"));
  try {
    const before = snapshot(dir);
    const calls: string[] = [];
    const exec = failingSave(calls);
    const r =
      which === "verifiedRestoreRoot"
        ? await verifiedRestoreRoot(exec, {
            repoRoot: dir,
            originalRef: "main",
            scratchDir: scratch,
            label: "t",
          })
        : await restoreRootToRefPreserving(exec, {
            repoRoot: dir,
            ref: "main",
            scratchDir: scratch,
            label: "t",
          });
    assert(
      snapshot(dir) === before,
      `${which}: a failed save leaves HEAD, index, status and files byte-identical`,
    );
    assert(
      !calls.some((c) => DESTRUCTIVE.test(c)),
      `${which}: no reset, checkout, stash or clean ran after the failed save (commands: ${JSON.stringify(calls)})`,
    );
    assert(
      r.restored === false && r.preservedAt === undefined,
      `${which}: the result is not-restored, nothing preserved`,
    );
    const claim = restoreClaim(r);
    assert(
      claim.startsWith("repoRoot was NOT restored") &&
        claim.includes("could not be saved") &&
        claim.includes("unable to read index") &&
        claim.includes(`the tree at ${dir} is left exactly as it was`),
      `${which}: the claim names the failure and the tree's path (got ${claim})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- 3. through a caller: integrate()'s conflict with a failed save --------
{
  const root = mkdtempSync(join(tmpdir(), "issue67-integrate-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  try {
    g(root, ["init", "-q", "--bare", "--initial-branch=main", origin]);
    g(root, ["init", "-q", "--initial-branch=main", repo]);
    g(repo, ["config", "user.email", "t@t"]);
    g(repo, ["config", "user.name", "t"]);
    writeFileSync(join(repo, "shared.txt"), "base line\n");
    g(repo, ["add", "."]);
    g(repo, ["commit", "-q", "-m", "base"]);
    g(repo, ["remote", "add", "origin", origin]);
    g(repo, ["push", "-q", "-u", "origin", "main"]);
    const setup = await mechanizedBranchSetup(realExec, repo, 67, [67], ["a", "b"], "issue 67");
    const wtA = setup.worktrees.a ?? "";
    const wtB = setup.worktrees.b ?? "";
    writeFileSync(join(wtA, "shared.txt"), "line from A\n");
    g(wtA, ["add", "."]);
    writeFileSync(join(wtB, "shared.txt"), "line from B\n");
    g(wtB, ["add", "."]);
    const calls: string[] = [];
    const res = await integrate(failingSave(calls), {
      repoRoot: repo,
      branchName: setup.branchName,
      baseSha: setup.baseSha,
      worktrees: setup.worktrees,
      scratchDir: join(root, "scratch"),
      commitTitle: "feat: conflicting",
      commitBody: "two workstreams, same file",
      mode: "create",
      requireAllNonEmpty: true,
      commitShas: {
        a: g(wtA, ["rev-parse", "HEAD"]).trim(),
        b: g(wtB, ["rev-parse", "HEAD"]).trim(),
      },
    });
    const reason = res.ok ? "" : res.reason;
    assert(
      !res.ok && reason.includes("could not be saved") && reason.includes(`the tree at ${repo}`),
      `integrate: the failure says the save failed and names the tree (got ${reason.slice(0, 400)})`,
    );
    assert(
      !reason.includes("verified"),
      "integrate: the failure does not claim the root was restored",
    );
    const firstSaveFail = calls.findIndex((c) => c === "git diff");
    assert(
      firstSaveFail >= 0 &&
        !calls.slice(firstSaveFail).some((c) => /reset --hard|checkout --force/.test(c)),
      `integrate: no reset --hard / checkout --force after the failed save (commands: ${JSON.stringify(calls.slice(firstSaveFail))})`,
    );
    assert(
      g(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim() === setup.branchName,
      "integrate: repoRoot is left on the integration branch, not forced back",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

process.exit(result.exit);
