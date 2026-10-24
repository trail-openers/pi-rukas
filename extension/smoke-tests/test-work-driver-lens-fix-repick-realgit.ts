#!/usr/bin/env bun
/**
 * Two lens-fix rounds against REAL git: round 2 must integrate only its own
 * commit.
 *
 * The live shape (one measured cycle): commit-pr put the feature on the
 * branch as F; round 1's fixer committed on top of F and the driver landed
 * it as R1; the reposition gate moved the worktree to R1; round 2's fixer
 * committed R2 on top. `landCommittedFix` then walked `baseSha..HEAD` =
 * [F, R1, R2], and the only "already on the branch" test was tree-hash
 * equality with the branch HEAD — true for the commit AT the tip, false for
 * every commit behind it. F was re-picked onto a branch that had since
 * rewritten F's lines, the pick conflicted, and the cycle parked
 * `lens-fix-not-integrated` with R2 stranded in the worktree.
 *
 * Deliberately NOT named `*-live.ts` — offline, same convention as
 * test-work-driver-981-divergence-realgit.ts.
 */

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { handleNoCommittedFix } from "../src/work-driver-adversarial-lensfix.ts";
import { mechanizedBranchSetup } from "../src/work-driver-branch-mechanized.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { explainCap } from "../src/work-driver-explain.ts";
import { integrate } from "../src/work-driver-integrate.ts";
import { landCommittedFix } from "../src/work-driver-lens-fix-commit.ts";
import { repositionLensFixWorktree } from "../src/work-driver-lens-fix-reposition-gate.ts";
import type { PipelineState } from "../src/workflow-state-schema.ts";
import type { WorkState } from "../src/workflow-state.ts";
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

// `sh -c`, NOT a login shell; honours the argv form (#1005) the reposition
// gate uses.
const realExec: ExecFn = async (cmd, o) => {
  if (o?.argv) {
    const { stdout } = await execFileP(cmd, o.argv, {
      cwd: o.cwd,
      maxBuffer: o.maxBuffer ?? 8 * 1024 * 1024,
    });
    return { stdout };
  }
  const { stdout } = await execFileP("/bin/sh", ["-c", cmd], {
    cwd: o?.cwd,
    maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024,
  });
  return { stdout };
};

const git = async (cwd: string, args: string[]) =>
  (await execFileP("git", args, { cwd })).stdout.trim();

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-repick-"));
const origin = path.join(root, "origin.git");
const repo = path.join(root, "repo");
const scratch = path.join(root, "scratch");
mkdirSync(scratch, { recursive: true });

try {
  await execFileP("git", ["init", "--bare", "--initial-branch=main", origin]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "meter.js"), "one\ntwo\nthree\n");
  writeFileSync(path.join(repo, "note.txt"), "alpha\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  // The driver excludes its scratch dir per clone; the restore's preserved
  // diff lands there.
  appendFileSync(path.join(repo, ".git", "info", "exclude"), "tmp/\n");
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);

  const setup = await mechanizedBranchSetup(realExec, repo, 51, [51], [], "repick");
  const wt = setup.worktrees.default ?? "";
  const branch = setup.branchName;
  const ps = { branchName: branch, baseSha: setup.baseSha, reviewRound: 1 } as PipelineState;
  const ctx = { repoRoot: repo, issue: 51 };

  // commit-pr: the feature lands on the branch as F.
  writeFileSync(path.join(wt, "meter.js"), "one\ndrawMeter(meter)\nthree\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "feat: the meter"]);
  const f0 = await integrate(realExec, {
    repoRoot: repo,
    branchName: branch,
    baseSha: setup.baseSha,
    worktrees: setup.worktrees,
    scratchDir: scratch,
    commitTitle: "feat: the meter",
    commitBody: "b",
    mode: "create",
  });
  assert(f0.ok && !f0.empty, "commit-pr landed the feature on the branch");

  // Round 1: the gate puts the fixer on the tip; the fix REWRITES a line the
  // feature commit wrote — which is what makes a later re-pick of F conflict.
  const rep1 = await repositionLensFixWorktree(realExec, wt, branch, [51], "repick");
  assert(rep1.kind !== "parked", `round 1: the reposition gate did not park (${rep1.kind})`);
  writeFileSync(path.join(wt, "meter.js"), "one\ndrawMeter(view.meter)\nthree\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "round 1 fix"]);
  const land1 = await landCommittedFix(realExec, ctx, ps, wt);
  assert(land1.ok, `round 1: the committed fix landed (${land1.ok ? "ok" : land1.error})`);
  const afterR1 = await git(repo, ["rev-list", "--count", `${setup.baseSha}..${branch}`]);
  assert(afterR1 === "2", `round 1: branch is F + R1 (got ${afterR1})`);

  // Round 2: the gate moves the worktree onto R1; the fixer commits R2.
  const rep2 = await repositionLensFixWorktree(realExec, wt, branch, [51], "repick");
  assert(rep2.kind !== "parked", `round 2: the reposition gate did not park (${rep2.kind})`);
  assert(
    (await git(wt, ["rev-parse", "HEAD"])) === (await git(repo, ["rev-parse", branch])),
    "round 2: the fixer starts on the branch tip",
  );
  writeFileSync(path.join(wt, "note.txt"), "alpha\nbeta\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-q", "-m", "round 2 fix"]);
  const r2Sha = await git(wt, ["rev-parse", "HEAD"]);
  const ps2 = { ...ps, reviewRound: 2 } as PipelineState;
  const land2 = await landCommittedFix(realExec, ctx, ps2, wt);
  assert(land2.ok, `round 2: the committed fix landed (${land2.ok ? "ok" : land2.error})`);
  const afterR2 = await git(repo, ["rev-list", "--count", `${setup.baseSha}..${branch}`]);
  assert(afterR2 === "3", `round 2: branch is F + R1 + R2, nothing re-picked (got ${afterR2})`);
  assert(
    (await git(repo, ["show", `${branch}:meter.js`])).includes("drawMeter(view.meter)"),
    "round 2: the round-1 fix is still on the branch",
  );
  assert(
    (await git(repo, ["show", `${branch}:note.txt`])).includes("beta"),
    "round 2: the round-2 fix is on the branch",
  );
  assert(
    (await git(repo, ["diff", "--name-only", branch, r2Sha])) === "",
    "round 2: the branch tip carries exactly the worktree's content",
  );
  assert(
    (await git(repo, ["log", "-1", "--format=%s", branch])) ===
      "fix(lens): round 2 review findings",
    "round 2: the commit is titled for round 2, not round 1",
  );
  assert((await git(repo, ["status", "--porcelain"])) === "", "round 2: repoRoot is clean");

  // A fix that genuinely cannot integrate: the branch moved under the fixer
  // on the same line. The park must name the fix and where it lives, and
  // must not tell the operator the findings were probably false positives.
  await git(repo, ["checkout", "-q", branch]);
  writeFileSync(path.join(repo, "note.txt"), "alpha\nsomeone else\n");
  await git(repo, ["commit", "-q", "-am", "moved under the fixer"]);
  await git(repo, ["checkout", "-q", "main"]);
  writeFileSync(path.join(wt, "note.txt"), "alpha\nbeta\ngamma\n");
  await git(wt, ["commit", "-q", "-am", "round 3 fix"]);
  const r3Sha = await git(wt, ["rev-parse", "HEAD"]);
  const state0 = {
    pipelineState: { ...ps, reviewRound: 3, plumbReports: [], worktrees: setup.worktrees },
    eventLog: [],
  } as unknown as WorkState;
  const parked = await handleNoCommittedFix(
    realExec,
    ctx as DriverContext,
    state0.pipelineState,
    wt,
    { committed: false },
    state0,
  );
  const cap = parked?.eventLog.at(-1) as { cap?: string; evidence?: string } | undefined;
  assert(cap?.cap === "lens-fix-not-integrated", "conflict: the cycle parks");
  const evidence = cap?.evidence ?? "";
  assert(evidence.includes(r3Sha.slice(0, 8)), `conflict: the park names the fix sha: ${evidence}`);
  assert(evidence.includes(wt), "conflict: the park names the worktree holding the fix");
  assert(evidence.includes("note.txt"), "conflict: the park names the conflicting file");
  const told = parked ? explainCap("lens-fix-not-integrated", parked) : "";
  assert(told.includes(r3Sha.slice(0, 12)), "conflict: the handoff names the fix sha");
  assert(told.includes(wt), "conflict: the handoff names the worktree holding the fix");
  assert(
    !told.includes("false positives") && !told.includes("if nothing exists"),
    `conflict: the handoff does not doubt findings a committed fix answered: ${told}`,
  );
  assert(
    (await git(repo, ["status", "--porcelain"])) === "",
    "conflict: repoRoot is clean after the restore",
  );
  assert(
    (await git(repo, ["symbolic-ref", "--short", "HEAD"])) === "main",
    "conflict: repoRoot is back on the ref it started from",
  );
  assert((await git(wt, ["rev-parse", "HEAD"])) === r3Sha, "conflict: the fix is still committed");
} finally {
  rmSync(root, { recursive: true, force: true });
}

process.exit(exit);
