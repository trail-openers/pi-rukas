#!/usr/bin/env bun
/**
 * #1093 — the abort restore never claims "verified restored" while untracked
 * files remain at repoRoot. The post-condition is one structured status read;
 * untracked entries do not fail the restore (the driver never sweeps them) but
 * the claim names every one it finds. Real git in temp repos.
 *
 *   1. the cycle leaves an unstaged untracked new file → the claim lists it
 *   2. the operator's own untracked file → not stashed, listed the same way
 *   3. a clean tree → the claim is "verified restored"
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreClaim, restoreRootToRefPreserving } from "../src/work-driver-restore.ts";
import { assert, buildRepo, head, realExec, result } from "./lib/restore-start-ref-fixtures.ts";

const git = (dir: string, args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8" });

// ---- 1. the cycle's own unstaged untracked file is named, never hidden ------
{
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1093-claim-cycle-scratch-"));
  try {
    git(dir, ["checkout", "-q", "feature/merged"]);
    writeFileSync(join(dir, "cyc-unstaged.txt"), "never added\n");
    const r = await restoreRootToRefPreserving(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "cycle",
    });
    const claim = restoreClaim(r, { label: "the batch was aborted and" });
    assert(head(dir) === "feature/x", "cycle-untracked: checkout moved to feature/x");
    assert(
      !claim.includes("verified restored"),
      `cycle-untracked: the claim never says "verified restored" (got ${JSON.stringify(claim)})`,
    );
    assert(
      claim.includes("1 untracked file(s) remain") && claim.includes("cyc-unstaged.txt"),
      `cycle-untracked: the claim lists the untracked file (got ${JSON.stringify(claim)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- 2. the operator's own untracked file is listed, and left in place -----
{
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1093-claim-operator-scratch-"));
  try {
    git(dir, ["checkout", "-q", "feature/merged"]);
    writeFileSync(join(dir, "operator-notes.txt"), "mine\n");
    const r = await restoreRootToRefPreserving(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "operator",
    });
    const claim = restoreClaim(r);
    assert(
      git(dir, ["status", "--porcelain"]).trim() === "?? operator-notes.txt",
      "operator-untracked: the operator's file is left in the checkout",
    );
    assert(
      !claim.includes("verified restored") && claim.includes("operator-notes.txt"),
      `operator-untracked: the claim lists the operator's file (got ${JSON.stringify(claim)})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- 3. a clean tree is verified restored ----------------------------------
{
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1093-claim-clean-scratch-"));
  try {
    git(dir, ["checkout", "-q", "feature/merged"]);
    const r = await restoreRootToRefPreserving(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "clean",
    });
    assert(
      restoreClaim(r) === "repoRoot was verified restored",
      `clean: the claim is verified restored (got ${JSON.stringify(restoreClaim(r))})`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (result.exit !== 0) process.exit(result.exit);
