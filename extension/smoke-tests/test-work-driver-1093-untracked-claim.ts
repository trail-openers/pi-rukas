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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreClaim, restoreRootToRefPreserving } from "../src/work-driver-restore.ts";
import { gitTestEnv, isolateGitEnv } from "./lib/git-test-env.ts";
import { assert, buildRepo, head, realExec, result } from "./lib/restore-start-ref-fixtures.ts";

// #1145 — a fixture repo must not read the host's global git config; see
// lib/git-test-env.ts for why the env is threaded per call AND set ambiently.
isolateGitEnv();

const git = (dir: string, args: string[]) =>
  execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitTestEnv() });

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
      // #1362 round 3 — the branch step recorded this file at cycle start, so
      // it is provenance-exempt. The claim spares it because it was ALREADY
      // HERE, not because git still calls it `??`.
      dirtyRootExemptBaseline: [".claude/settings.local.json"],
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

// ---- 2d. #1362 fix round — a file the CYCLE wrote under an exempt prefix is
// still stashed, and still recoverable. The exemption filters the untracked
// list the claim prints; it must NOT filter the stash pathspec, or the cycle's
// own work is left in the tree for the checkout to walk over. Real git.
{
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1362-claim-stash-scratch-"));
  try {
    const g = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitTestEnv() });
    g(["checkout", "-q", "feature/merged"]);
    // The cycle's own deliverable, written under a prefix the project happens
    // to list (a tool directory the project exempted that the develop step also
    // writes into), and staged: this is the ONLY read that can tell it from a
    // stray, because after the mixed reset both are `??`.
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "generated-by-the-cycle.json"), '{"cycle":true}\n');
    g(["add", "--", ".claude/generated-by-the-cycle.json"]);
    // The pre-existing tool file the cycle never wrote — the settlement case.
    // Left unstaged, exactly as a stray is: `??`, where the deliverable is `A`.
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{}\n");
    // A non-exempt untracked file, so the claim still proves it can name one.
    writeFileSync(join(dir, "operator-notes.txt"), "mine\n");
    const r = await restoreRootToRefPreserving(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "cycle-under-exempt",
      dirtyRootExempt: [".claude"],
      // #1362 round 3 — the branch step's baseline lists only the pre-existing
      // tool file. That single entry is what tells the two `??` files apart
      // after the mixed reset: the deliverable is named, the stray is spared.
      dirtyRootExemptBaseline: [".claude/settings.local.json"],
    });
    const claim = restoreClaim(r);
    assert(
      r.restored === true && head(dir) === "feature/x",
      `#1362 stash: the checkout landed on feature/x (restored=${r.restored}, head=${head(dir)}, detail=${JSON.stringify(r.detail)})`,
    );
    assert(
      g(["stash", "list"]).includes("pi-rukas #1093"),
      "#1362 stash: a stash entry was created for the cycle's changes",
    );
    // The decisive half: the stash's own pathspec, read from git.
    const stashFiles = g([
      "stash",
      "show",
      "--include-untracked",
      "--name-only",
      "stash@{0}",
    ]).split("\n");
    assert(
      stashFiles.some((f) => f.trim() === ".claude/generated-by-the-cycle.json"),
      `#1362 stash: the cycle-written file under an exempt prefix IS in the stash, so it is recoverable (stash holds ${JSON.stringify(stashFiles.filter(Boolean))})`,
    );
    assert(
      !existsSync(join(dir, ".claude", "generated-by-the-cycle.json")),
      "#1362 stash: the cycle-written file is out of the working tree, not left behind for the next cycle to trip over",
    );
    // ...and recoverable means recoverable: popping it back reproduces the bytes.
    g(["stash", "pop"]);
    assert(
      existsSync(join(dir, ".claude", "generated-by-the-cycle.json")) &&
        readFileSync(join(dir, ".claude", "generated-by-the-cycle.json"), "utf8") ===
          '{"cycle":true}\n',
      "#1362 stash: popping the stash restores the cycle's file byte-for-byte",
    );
    // The settlement, on the same fixture: a pre-existing exempt file the cycle
    // did not write is neither saved nor restored by a claim — it was never
    // named, never stashed, and it stayed on disk the whole time.
    assert(
      !claim.includes("settings.local.json"),
      `#1362 settlement: the untouched exempt tool file is not named by the claim (got ${JSON.stringify(claim)})`,
    );
    assert(
      !stashFiles.some((f) => f.trim() === ".claude/settings.local.json"),
      "#1362 settlement: the untouched exempt tool file was never stashed",
    );
    assert(
      existsSync(join(dir, ".claude", "settings.local.json")),
      "#1362 settlement: the untouched exempt tool file was never moved or restored",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- 2e. #1362 round 3 — the claim decides by PROVENANCE, not by the code.
//
// After the abort path's mixed reset, a staged-new file the cycle wrote and a
// tool's stray that was merely sitting there are BOTH `??`, so no code read
// distinguishes them. The cycle-start baseline does. Three fixtures, all under
// one exempt prefix, differing only in what the baseline says:
//
//   (a) unstaged cycle-written file, absent from the baseline → NAMED;
//   (b) a pre-existing tool file IN the baseline → not named, not stashed;
//   (c) no baseline at all (an old state file) → everything is named.
//
// Real git, so the `??`/`A` codes, the stash and the checkout are git's own.
{
  // (a) + (b): the same tree, one baseline entry, two opposite outcomes.
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1362-claim-prov-scratch-"));
  try {
    const g = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitTestEnv() });
    g(["checkout", "-q", "feature/merged"]);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    // Written by the develop step, never staged — so it reads `??` both before
    // and after the reset, and only "was it here at cycle start?" separates it
    // from the tool file beside it.
    writeFileSync(join(dir, ".claude", "cycle-output.json"), '{"cycle":true}\n');
    // The operator's tool file, which the branch step recorded at cycle start.
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{}\n");
    const r = await restoreRootToRefPreserving(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "provenance",
      dirtyRootExempt: [".claude"],
      dirtyRootExemptBaseline: [".claude/settings.local.json"],
    });
    const claim = restoreClaim(r);
    assert(
      claim.includes("cycle-output.json"),
      `#1362 provenance: an UNSTAGED cycle-written file under an exempt prefix IS named (got ${JSON.stringify(claim)})`,
    );
    assert(
      !claim.includes("settings.local.json"),
      `#1362 provenance: a pre-existing exempt tool file IN the baseline is not named (got ${JSON.stringify(claim)})`,
    );
    assert(
      !claim.includes("verified restored"),
      `#1362 provenance: the claim does not say "verified restored" while a cycle file remains (got ${JSON.stringify(claim)})`,
    );
    // The baseline file was never stashed and is still on disk byte-for-byte.
    assert(
      !g(["stash", "list"]).includes("provenance") ||
        !g(["stash", "show", "--include-untracked", "--name-only", "stash@{0}"])
          .split("\n")
          .some((f) => f.trim() === ".claude/settings.local.json"),
      "#1362 provenance: the baseline tool file was not stashed",
    );
    assert(
      existsSync(join(dir, ".claude", "settings.local.json")) &&
        readFileSync(join(dir, ".claude", "settings.local.json"), "utf8") === "{}\n",
      "#1362 provenance: the baseline tool file was not saved or restored — its bytes never moved",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- 2f. #1362 round 3 — an absent baseline names EVERYTHING -------------
// The fail-closed direction: a state file from before the field existed (or a
// cycle whose baseline could not be taken) exempts nothing from the claim, so
// the worst it does is name a tool file it might have spared. It never hides the
// cycle's own work, which is the failure this field exists to prevent.
{
  const dir = buildRepo();
  const scratch = mkdtempSync(join(tmpdir(), "issue1362-claim-nobase-scratch-"));
  try {
    const g = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitTestEnv() });
    g(["checkout", "-q", "feature/merged"]);
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "cycle-output.json"), '{"cycle":true}\n');
    writeFileSync(join(dir, ".claude", "settings.local.json"), "{}\n");
    const r = await restoreRootToRefPreserving(realExec, {
      repoRoot: dir,
      ref: "feature/x",
      scratchDir: scratch,
      label: "no-baseline",
      dirtyRootExempt: [".claude"],
      // deliberately no dirtyRootExemptBaseline
    });
    const claim = restoreClaim(r);
    assert(
      claim.includes("2 untracked file(s) remain") &&
        claim.includes("cycle-output.json") &&
        claim.includes("settings.local.json"),
      `#1362 fail-closed: with no baseline the claim names EVERY untracked path under the exempt prefix (got ${JSON.stringify(claim)})`,
    );
    // And the empty-array form behaves the same as absent — no "empty means
    // everything is exempt" reading of the field.
    const dir2 = buildRepo();
    try {
      const g2 = (args: string[]) =>
        execFileSync("git", args, { cwd: dir2, encoding: "utf8", env: gitTestEnv() });
      g2(["checkout", "-q", "feature/merged"]);
      mkdirSync(join(dir2, ".claude"), { recursive: true });
      writeFileSync(join(dir2, ".claude", "settings.local.json"), "{}\n");
      const r2 = await restoreRootToRefPreserving(realExec, {
        repoRoot: dir2,
        ref: "feature/x",
        scratchDir: scratch,
        label: "empty-baseline",
        dirtyRootExempt: [".claude"],
        dirtyRootExemptBaseline: [],
      });
      assert(
        restoreClaim(r2).includes("settings.local.json"),
        `#1362 fail-closed: an EMPTY baseline is the same as absent — nothing is claim-exempt (got ${JSON.stringify(restoreClaim(r2))})`,
      );
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
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
