#!/usr/bin/env bun
/**
 * #782 — the commit-pr consolidated-verify seam's single flake retry.
 *
 * The commit-pr twin of the develop-seam flake retry (test-work-driver-
 * verify-flake.ts). On a consolidated-tree verify failure at commit-pr
 * (integrate() step 4) where every per-worktree verify passed (always true
 * at this seam) and there are multiple workstreams (N>1), the gate now
 * re-runs the SAME verify command ONCE in the SAME still-checked-out
 * integration tree BEFORE classifying. If the re-run passes, integrate()
 * proceeds (the flake was a false alarm); if it fails too, classification
 * and park proceed as today.
 *
 * Three cases:
 *   1. Fail-then-pass (stateful sh -c): the flaky assertion fails on the
 *      first run (flag absent) and passes on the second (flag present).
 *      → integrate() succeeds, the branch is pushed.
 *   2. Fail-both (permanent defect): the verify command fails both runs.
 *      → integrate() fails with failure === "verify", the branch is NOT
 *      pushed, and the reason carries the classification label.
 *   3. ciRetryCount > 0: the verify command fails on the first run but the
 *      retry is SKIPPED (the cycle has already retried once via ciRetry).
 *      → integrate() fails with failure === "verify" (no second run).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { integrate } from "../src/work-driver-integrate.ts";
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
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-782-cpprv-"));

async function fixture(name: string, ids: string[], seed: Record<string, string> = {}) {
  const dir = path.join(root, name);
  const originDir = path.join(dir, "origin.git");
  const repo = path.join(dir, "repo");
  const scratch = path.join(dir, "scratch");
  mkdirSync(scratch, { recursive: true });
  await execFileP("git", ["init", "--bare", "--initial-branch=main", originDir]);
  await execFileP("git", ["init", "--initial-branch=main", repo]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  for (const [rel, body] of Object.entries(seed)) writeFileSync(path.join(repo, rel), body);
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", originDir]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  const { stdout: sha } = await git(repo, ["rev-parse", "HEAD"]);
  const worktrees: Record<string, string> = {};
  for (const id of ids) {
    const wt = path.join(dir, `wt-${id}`);
    await git(repo, ["worktree", "add", "--detach", wt, sha.trim()]);
    worktrees[id] = wt;
  }
  return { repo, scratch, baseSha: sha.trim(), worktrees, originDir };
}

function commitIn(wt: string, msg: string) {
  return execFileP("git", ["add", "."], { cwd: wt }).then(() =>
    execFileP("git", ["commit", "-q", "-m", msg], { cwd: wt }),
  );
}

try {
  // ------------------------- case 1 — fail-then-pass (flake recovers)
  // A transient flake: the verify command fails on the first run (flag
  // absent) and passes on the second (flag present, created by the first
  // run's `touch`). The retry must recover and integrate() must proceed.
  {
    const f = await fixture("flake-recover", ["a", "b"], {
      "afile.txt": "a\n",
      "bfile.txt": "b\n",
    });
    writeFileSync(path.join(f.worktrees.a as string, "afile.txt"), "a edited\n");
    await commitIn(f.worktrees.a as string, "task-a: edit a");
    writeFileSync(path.join(f.worktrees.b as string, "bfile.txt"), "b edited\n");
    await commitIn(f.worktrees.b as string, "task-b: edit b");

    const flag = path.join(f.repo, "flake-retry.flag");
    // The verify command fails when the flag file is absent (first run)
    // and passes when present (second run after the first run created it).
    const verifyCmd = `sh -c 'test -f ${flag} || { touch ${flag}; exit 1; }'`;
    const r = await integrate(realExec, {
      repoRoot: f.repo,
      branchName: "feature/flake-recover",
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      scratchDir: f.scratch,
      commitTitle: "feat: flake recover",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      verifyCmd,
    });
    assert(r.ok, "flake-recover: a fail-then-pass verify → integrate() succeeds (retry recovered the flake)");
    // The flag file must exist now (created by the first run's `touch`).
    let flagExists = false;
    try {
      await import("node:fs").then(async (fs) => {
        flagExists = fs.existsSync(flag);
      });
    } catch {
      flagExists = false;
    }
    assert(flagExists, "flake-recover: the first run created the flag file (stateful fixture confirms a retry happened)");
    // The branch must have been pushed.
    const { stdout } = await execFileP("git", ["branch", "-a"], { cwd: f.originDir });
    assert(stdout.includes("feature/flake-recover"), "flake-recover: the branch reached origin after the flake recovered");
  }

  // ------------------------- case 2 — fail-both (genuine defect)
  // The verify command fails on both runs. The retry does NOT mask a real
  // failure — integrate() must fail with failure === "verify".
  {
    const f = await fixture("flake-failboth", ["a", "b"], {
      "afile.txt": "a\n",
      "bfile.txt": "b\n",
    });
    // Both workstreams delete the same file — a genuine consolidated defect
    // that fails both runs regardless of state.
    rmSync(path.join(f.worktrees.a as string, "bfile.txt"));
    await commitIn(f.worktrees.a as string, "task-a: delete bfile");
    writeFileSync(path.join(f.worktrees.b as string, "afile.txt"), "a edited\n");
    await commitIn(f.worktrees.b as string, "task-b: edit a");

    // Always fails — no stateful recovery.
    const verifyCmd = "test -f bfile.txt";
    const r = await integrate(realExec, {
      repoRoot: f.repo,
      branchName: "feature/flake-failboth",
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      scratchDir: f.scratch,
      commitTitle: "feat: flake failboth",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      verifyCmd,
    });
    assert(!r.ok, "flake-failboth: a verify that fails both runs → integrate() fails (the retry did not mask a real failure)");
    assert(
      !r.ok && r.failure === "verify",
      "flake-failboth: the failure is tagged `verify` — the gate still halts on a genuine defect",
    );
    assert(
      !r.ok && /\[consolidation-created\]|\[per-workstream-defect\]|\[needs-human-decision\]/.test(r.reason),
      "flake-failboth: the reason carries the classification label (both runs failed, so classification proceeded)",
    );
    // The branch must NOT have been pushed.
    const { stdout: remoteBranches } = await execFileP("git", ["branch", "-a"], { cwd: f.originDir });
    assert(
      !remoteBranches.includes("feature/flake-failboth"),
      "flake-failboth: the branch never reached origin (the retry did not launder a genuine failure)",
    );
  }

  // ------------------------- case 3 — ciRetryCount > 0 (retry skipped)
  // A prior ci-retry already ran the verify command (ciRetryCount > 0).
  // The single flake retry must be SKIPPED — the precondition (first run)
  // is not met. The verify command fails on the first run; because the
  // retry is skipped, integrate() fails without a second attempt.
  {
    const f = await fixture("flake-ciretry", ["a", "b"], {
      "afile.txt": "a\n",
      "bfile.txt": "b\n",
    });
    writeFileSync(path.join(f.worktrees.a as string, "afile.txt"), "a edited\n");
    await commitIn(f.worktrees.a as string, "task-a: edit a");
    writeFileSync(path.join(f.worktrees.b as string, "bfile.txt"), "b edited\n");
    await commitIn(f.worktrees.b as string, "task-b: edit b");

    // This command would fail on the first run and pass on the second (same
    // stateful shape as case 1) — but because ciRetryCount > 0, the retry
    // is skipped and integrate() fails on the first run's failure.
    const flag = path.join(f.repo, "flake-ciretry.flag");
    const verifyCmd = `sh -c 'test -f ${flag} || { touch ${flag}; exit 1; }'`;
    const r = await integrate(realExec, {
      repoRoot: f.repo,
      branchName: "feature/flake-ciretry",
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      scratchDir: f.scratch,
      commitTitle: "feat: flake ciretry",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      verifyCmd,
      verifyRetry: { ciRetryCount: 1, onRecover: () => {} },
    });
    assert(!r.ok, "flake-ciretry: with ciRetryCount > 0 the retry is skipped → integrate() fails (no second run)");
    assert(
      !r.ok && r.failure === "verify",
      "flake-ciretry: the failure is tagged `verify` — the ci-retry guard prevents a second flake retry",
    );
    // The branch must NOT have been pushed.
    const { stdout: remoteBranches } = await execFileP("git", ["branch", "-a"], { cwd: f.originDir });
    assert(
      !remoteBranches.includes("feature/flake-ciretry"),
      "flake-ciretry: the branch never reached origin",
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
