#!/usr/bin/env bun
/**
 * #1093 — two adversarial findings on the abort restore and the start ref:
 *
 *  1. The abort path's mixed `git reset` turns the cycle's staged NEW files
 *     untracked. A tracked-only stash left them in the operator's tree while
 *     the claim said "verified restored". The stash now carries `-u` scoped to
 *     the cycle's own paths, so the operator's untracked files are never
 *     stashed, and the post-condition checks those same paths (untracked
 *     included).
 *  2. Start-ref race across groups: a sibling that leaves repoRoot on its own
 *     branch must not become this cycle's start ref. The queue captures the
 *     ref once per invocation, and the stamp uses that value.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampCycleStartRef } from "../src/work-driver-branch-develop.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { captureInvocationStartRef } from "../src/work-driver-git.ts";
import { restoreClaim, restoreRootToRefPreserving } from "../src/work-driver-restore.ts";
import type { ExecFn } from "../src/worktree.ts";
import { assert, buildRepo, head, realExec, result, stateWith } from "./lib/restore-start-ref-fixtures.ts";

const git = (dir: string, args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" });

// ---- 1. abort: a staged NEW cycle file must not stay in the operator's tree --
{
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1093-untracked-scratch-"));
  try {
    git(dir, ["checkout", "-q", "feature/merged"]);
    // feature/x does NOT track cyc-new.txt: after the mixed reset it is untracked.
    writeFileSync(join(dir, "cyc-new.txt"), "cycle new file\n");
    writeFileSync(join(dir, "tracked.txt"), "carried\n");
    git(dir, ["add", "cyc-new.txt", "tracked.txt"]);
    const r = await restoreRootToRefPreserving(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "abort",
    });
    assert(r.restored && head(dir) === "feature/x", "abort: restored onto feature/x");
    assert(
      !existsSync(join(dir, "cyc-new.txt")),
      "abort: the cycle's new file is NOT in the operator's tree",
    );
    assert(
      git(dir, ["status", "--porcelain"]).trim() === "",
      "abort: tree verified clean (incl. untracked)",
    );
    const stash = git(dir, ["stash", "list"]).trim();
    assert(stash.length > 0, "abort: the cycle's changes are in a recoverable stash");
    const stashedNew = git(dir, ["show", "stash@{0}^3:cyc-new.txt"]);
    assert(
      stashedNew === "cycle new file\n",
      "abort: the untracked cycle file is recoverable from the stash",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- 1a. abort: the operator's OWN untracked file is not displaced --------
{
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1093-operator-untracked-scratch-"));
  try {
    git(dir, ["checkout", "-q", "feature/merged"]);
    writeFileSync(join(dir, "notes.txt"), "operator notes\n");
    writeFileSync(join(dir, "cyc-new.txt"), "cycle new file\n");
    git(dir, ["add", "cyc-new.txt"]);
    const r = await restoreRootToRefPreserving(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "operator-untracked",
    });
    assert(r.restored && head(dir) === "feature/x", "operator-untracked: restored onto feature/x");
    assert(
      readFileSync(join(dir, "notes.txt"), "utf8") === "operator notes\n",
      "operator-untracked: the operator's untracked file stayed in the tree",
    );
    assert(
      !git(dir, ["ls-tree", "-r", "--name-only", "stash@{0}^3"]).includes("notes.txt"),
      "operator-untracked: the operator's untracked file is NOT in the stash",
    );
    assert(
      git(dir, ["status", "--porcelain"]).trim() === "?? notes.txt",
      "operator-untracked: the only remaining entry is the operator's own file",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- 1b. abort: a leftover untracked cycle file means NOT verified ---------
{
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1093-leftover-scratch-"));
  try {
    git(dir, ["checkout", "-q", "feature/merged"]);
    writeFileSync(join(dir, "cyc-new.txt"), "cycle new file\n");
    git(dir, ["add", "cyc-new.txt"]);
    // Simulate a stash that silently did nothing: the leftover must be reported.
    const noStash: ExecFn = (cmd, opts) =>
      opts?.argv?.includes("stash")
        ? Promise.resolve({ stdout: "", stderr: "" })
        : realExec(cmd, opts);
    const r = await restoreRootToRefPreserving(noStash, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "leftover",
    });
    const claim = restoreClaim(r);
    assert(
      !claim.includes("verified restored"),
      `leftover: the claim is NOT verified restored (got ${JSON.stringify(claim)})`,
    );
    assert(
      claim.includes("cyc-new.txt"),
      `leftover: the claim names the leftover file (got ${JSON.stringify(claim)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- 2. start ref: a sibling's branch move must not become the start ref --
{
  const dir = buildRepo();
  try {
    git(dir, ["checkout", "-q", "main"]);
    // The queue reads the operator's checkout ONCE, before any group starts.
    const invocationStartRef = await captureInvocationStartRef(dir);
    assert(
      invocationStartRef === "main",
      `start ref: invocation captured main (got ${invocationStartRef})`,
    );
    // Group A leaves repoRoot on its own feature branch (a restore that failed).
    git(dir, ["checkout", "-q", "-b", "feature/issue-A"]);
    const ctx = {
      repoRoot: dir,
      verifyExecFn: realExec,
      invocationStartRef,
    } as unknown as DriverContext;
    const stamped = await stampCycleStartRef(ctx, stateWith(undefined, "B"));
    assert(
      stamped.pipelineState.startRef === "main",
      `start ref: group B records the operator's original branch, not feature/issue-A (got ${stamped.pipelineState.startRef})`,
    );
    const onDisk = readFileSync(join(dir, ".pi", "work-state", "1093.json"), "utf8");
    assert(
      onDisk.includes('"startRef": "main"') || onDisk.includes('"startRef":"main"'),
      "start ref: persisted as main",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exit(result.exit);
