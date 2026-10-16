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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// ---- 2b. #1362 — an exempt untracked file is neither named nor stashed -----
//
// The restore claim prints the untracked files it found, and the abort path
// builds its stash pathspec from the same read. The project's
// `.pi/dirty-root-exempt` list removes a tool's own file from BOTH: the claim
// says "verified restored" instead of naming it, and nothing is stashed under
// it. A non-exempt untracked file beside it is still named — the exemption is
// a list, not a wildcard.
{
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1362-claim-exempt-scratch-"));
  try {
    git(dir, ["checkout", "-q", "feature/merged"]);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    const exemptFile = join(dir, ".claude", "settings.local.json");
    writeFileSync(exemptFile, "{}\n");
    writeFileSync(join(dir, "operator-notes.txt"), "mine\n");
    const r = await restoreRootToRefPreserving(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "exempt",
      dirtyRootExempt: [".claude"],
    });
    const claim = restoreClaim(r);
    assert(
      !claim.includes("settings.local.json"),
      `exempt: the claim does not name the exempt tool file (got ${JSON.stringify(claim)})`,
    );
    assert(
      claim.includes("operator-notes.txt"),
      `exempt: a NON-exempt untracked file is still named (got ${JSON.stringify(claim)})`,
    );
    // Nothing was stashed under the exempt prefix: the operator's file is on
    // disk and the exempt one was never moved into a stash.
    assert(
      git(dir, ["status", "--porcelain", "-uall"]).includes(".claude/settings.local.json"),
      "exempt: the exempt file is left in the checkout, not stashed away",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- 2c. #1362 — with no list the claim is byte-identical to case 2 --------
{
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1362-claim-nolist-scratch-"));
  try {
    git(dir, ["checkout", "-q", "feature/merged"]);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{}\n");
    const r = await restoreRootToRefPreserving(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "nolist",
    });
    const claim = restoreClaim(r);
    assert(
      claim.includes("1 untracked file(s) remain") && claim.includes(".claude/settings.local.json"),
      `no-list: without the config the exempt-looking path is named as before (got ${JSON.stringify(claim)})`,
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
