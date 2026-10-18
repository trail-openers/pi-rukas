#!/usr/bin/env bun
/**
 * #1468 — the develop gate on a continued PR judges M..H, the PR's own diff.
 *
 * P is the PR head, M the mainline commit merged in, H the worktree HEAD. The
 * state carries baseSha = M, so a `.github/` change that exists only on main is
 * outside the range, while a protected change on the PR side is still caught.
 * A merge left unfinished fails the gate, so it goes back to the developer.
 *
 * Real git repos in temp dirs; no dispatches.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execp } from "../src/exec.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { verifyDevelopOutcome } from "../src/work-driver-verify-develop.ts";
import { initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(dir: string, file: string, body: string): void {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), body);
}

function commit(dir: string, file: string, body: string, msg: string): string {
  write(dir, file, body);
  git(dir, "add", "--", file);
  git(dir, "commit", "-q", "-m", msg);
  return git(dir, "rev-parse", "HEAD");
}

type Shape = { prFile: string; mainFile: string; conflict: boolean };

/** A repo with a PR branch and a later main, and a worktree at P with M merged in. */
function continuedWorktree(shape: Shape) {
  const root = mkdtempSync(path.join(tmpdir(), "continue-gate-"));
  git(root, "init", "-q", "--initial-branch=main");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  commit(root, "shared.txt", "one\n", "base");
  git(root, "checkout", "-q", "-b", "pr");
  const P = commit(root, shape.prFile, "pr side\n", "feat: the PR");
  git(root, "checkout", "-q", "main");
  const M = commit(root, shape.mainFile, "main side\n", "chore: main moves on");
  const wt = path.join(root, ".worktrees", "issue-1468-default");
  git(root, "worktree", "add", "-q", "--detach", wt, P);
  try {
    git(wt, "merge", "--no-ff", "--no-edit", "-m", "Merge branch 'main' into pr", M);
  } catch {
    if (!shape.conflict) throw new Error("unexpected merge conflict");
  }
  let s = initialState(1468, Date.now());
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "develop",
      baseSha: M,
      worktrees: { default: wt },
      workstreamBaseShas: { default: M },
      continuedPr: {
        number: 77,
        headRefName: "pr",
        headSha: P,
        mainlineSha: M,
        conflictPaths: shape.conflict ? [shape.prFile] : [],
        matchedBy: "body",
      },
    },
  };
  const ctx = {
    host: { sendUserMessage: () => {} },
    repoRoot: root,
    issue: 1468,
    verifyExecFn: execp,
  } as unknown as DriverContext;
  return { root, state: s, ctx };
}

async function gate(shape: Shape): Promise<string[]> {
  const { root, state, ctx } = continuedWorktree(shape);
  try {
    const failures: string[] = [];
    await verifyDevelopOutcome(ctx, state, execp, failures, []);
    return failures;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

process.env.PI_ENSEMBLE_COMMENT_RETENTION = "0";

{
  const failures = await gate({ prFile: "src/a.ts", mainFile: ".github/x.yml", conflict: false });
  assert(
    !failures.some((f) => f.includes(".github")),
    `a .github/ change only on main does not trip the protected-path gate (got: ${failures.join("; ")})`,
  );
  assert(
    !failures.some((f) => f.startsWith("continue-pr:")),
    "a finished clean merge passes the continue-PR check",
  );
}

{
  const failures = await gate({ prFile: ".github/y.yml", mainFile: "src/b.ts", conflict: false });
  assert(
    failures.some((f) => f.includes(".github/y.yml")),
    `a protected change on the PR side still trips the gate (got: ${failures.join("; ")})`,
  );
}

{
  const failures = await gate({ prFile: "shared.txt", mainFile: "shared.txt", conflict: true });
  assert(
    failures.some((f) => f.startsWith("continue-pr:") && f.includes("MERGE_HEAD")),
    `an unfinished merge lands in the develop gate's failures (got: ${failures.join("; ")})`,
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
