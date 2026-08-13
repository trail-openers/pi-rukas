#!/usr/bin/env bun
/**
 * Nothing had ever compiled the COMBINATION before it became a PR.
 *
 * Every gate upstream sees one workstream in isolation: the develop gate runs
 * inside a single worktree, and adversarial reviews a single worktree's diff.
 * The first build of the integrated tree happened at `ci` — after `commit-pr`
 * had pushed, after the PR existed, and after six lenses had spent up to two
 * hours reviewing it. Four of nine measured lantern cycles died at lens-review;
 * none ever reached `ci`, so in practice the integrated tree was NEVER built.
 *
 * Two workstreams that each verify alone can still fail together — one renames
 * or moves what another still refers to. That defect is CREATED by integration,
 * which makes integration the only place it can be caught.
 *
 * The second half matters as much as the first. `runCommitPr` falls back to an
 * LLM ops dispatch on a mechanized failure, and that dispatch commits and
 * pushes on its own. Routing a verify failure into it would have produced a
 * textbook #328 gate-that-cannot-fail: the mechanized path refuses, ops ships
 * the identical broken tree, and the check reads as passing because nothing
 * ever reports it. So a verify failure is `terminal` and halts the cycle.
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
const root = mkdtempSync(path.join(tmpdir(), "pi-ens-intverify-"));

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

try {
  // ------------------- a tree that fails verify is never pushed
  {
    // The realistic shape: A deletes a helper it no longer needs, B adds a new
    // caller of that same helper. Each worktree builds; the union does not.
    const f = await fixture("breaks", ["a", "b"], {
      "helper.sh": "echo helper\n",
      "main.sh": "echo main\n",
    });
    rmSync(path.join(f.worktrees.a as string, "helper.sh"));
    writeFileSync(path.join(f.worktrees.b as string, "main.sh"), "sh ./helper.sh\n");

    const r = await integrate(realExec, {
      repoRoot: f.repo,
      branchName: "feature/breaks",
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      scratchDir: f.scratch,
      commitTitle: "feat: x",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      // Stands in for the project's real gate: fails iff the union is broken.
      verifyCmd: "test -f helper.sh",
    });

    assert(!r.ok, "canary: a consolidated tree that fails verify does not integrate");
    assert(
      !r.ok && r.failure === "verify",
      "canary: the failure is tagged `verify` — callers must distinguish a verdict from env variance",
    );
    assert(
      !r.ok && /was not pushed/.test(r.reason),
      `canary: the reason says it was not pushed (got "${r.ok ? "" : r.reason.slice(0, 90)}")`,
    );

    // Nothing may have reached the remote — that is the whole point.
    const { stdout: remoteBranches } = await execFileP("git", ["branch", "-a"], {
      cwd: f.originDir,
    });
    assert(
      !remoteBranches.includes("feature/breaks"),
      `canary: the branch never reached origin (got "${remoteBranches.trim()}")`,
    );
    // And repoRoot is back where it started, per the same rollback contract
    // every other integration failure honours.
    const { stdout: dirt } = await git(f.repo, ["status", "--porcelain"]);
    const { stdout: head } = await git(f.repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    assert(
      dirt.trim() === "" && head.trim() === "main",
      `canary: repoRoot restored (branch=${head.trim()}, dirt=${JSON.stringify(dirt.trim())})`,
    );
  }

  // ------------------------- a tree that passes verify is pushed
  {
    const f = await fixture("builds", ["a", "b"], { "afile.txt": "a\n", "bfile.txt": "b\n" });
    writeFileSync(path.join(f.worktrees.a as string, "afile.txt"), "a edited\n");
    writeFileSync(path.join(f.worktrees.b as string, "bfile.txt"), "b edited\n");
    const r = await integrate(realExec, {
      repoRoot: f.repo,
      branchName: "feature/builds",
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      scratchDir: f.scratch,
      commitTitle: "feat: x",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      verifyCmd: "test -f afile.txt && test -f bfile.txt",
    });
    assert(r.ok && !r.empty, `a passing tree still integrates (got ${r.ok ? "ok" : r.reason}`);
    const { stdout } = await execFileP("git", ["branch", "-a"], { cwd: f.originDir });
    assert(stdout.includes("feature/builds"), "...and reaches origin");
  }

  // ------------- a project with no verify command is not newly blocked
  {
    const f = await fixture("noverify", ["a"], { "afile.txt": "a\n" });
    writeFileSync(path.join(f.worktrees.a as string, "afile.txt"), "a edited\n");
    const r = await integrate(realExec, {
      repoRoot: f.repo,
      branchName: "feature/noverify",
      baseSha: f.baseSha,
      worktrees: f.worktrees,
      scratchDir: f.scratch,
      commitTitle: "feat: x",
      commitBody: "b",
      mode: "create",
      requireAllNonEmpty: true,
      // verifyCmd omitted — `verifyCmdFor` returns undefined for such a repo.
    });
    assert(r.ok, "a repo with no verify command integrates exactly as before");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// -------------- the verify verdict must not be laundered through ops
{
  const { readFileSync } = await import("node:fs");
  const SRC = path.resolve(import.meta.dirname, "..", "src");
  const commit = readFileSync(path.join(SRC, "work-driver-commit.ts"), "utf8");
  const code = commit.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  assert(
    /terminal:\s*res\.failure === "verify"/.test(code),
    "canary: a verify failure is marked terminal — every other failure still falls back",
  );
  // The load-bearing branch: `terminal` must be handled BEFORE the else that
  // builds the ops fallback, or the gate cannot fail.
  const mechIdx = code.indexOf("const mech = await mechanizedCommitPr");
  const terminalIdx = code.indexOf("mech.terminal", mechIdx);
  const fallbackIdx = code.indexOf("inlineCommitPrPrompt", mechIdx);
  assert(
    mechIdx >= 0 && terminalIdx > mechIdx && terminalIdx < fallbackIdx,
    "canary: the terminal branch is checked before the ops fallback is reached",
  );
  assert(
    /cap: "integration-verify-failed"/.test(code),
    "canary: it halts with a named cap rather than failing silently",
  );

  const explain = readFileSync(path.join(SRC, "work-driver-explain.ts"), "utf8");
  assert(
    /case "integration-verify-failed"/.test(explain),
    "the cap has an operator-facing explanation — an unexplained cap reads as a crash",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
