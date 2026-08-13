#!/usr/bin/env bun
/**
 * #287 — always-worktree isolation.
 *
 * The property under test is structural: repoRoot is an INTEGRATION POINT,
 * never a development tree. Everything else in this file exists to pin that.
 *
 * Pre-#287, `runBranch` set `worktrees = {default: repoRoot}` for N=1, so
 * development happened in the operator's own checkout. That is why stale
 * repoRoot residue was swept into a merged PR (incident #602), why an aborted
 * step left a dirty tree that wedged every downstream issue's branch step, and
 * why parallel groups were impossible.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  branchSlug,
  detectMainline,
  mechanizedBranchSetup,
} from "../src/work-driver-branch-mechanized.ts";
import { integrate } from "../src/work-driver-integrate.ts";
import type { ExecFn } from "../src/worktree.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** Records every (command, cwd) pair so tests can assert on where git ran. */
function recorder(overrides: Record<string, string> = {}) {
  const calls: Array<{ cmd: string; cwd: string }> = [];
  const execFn: ExecFn = async (cmd, o) => {
    calls.push({ cmd, cwd: o?.cwd ?? "" });
    for (const [prefix, stdout] of Object.entries(overrides)) {
      if (cmd.startsWith(prefix)) {
        if (stdout.startsWith("!THROW!")) throw new Error(stdout.slice(7));
        return { stdout };
      }
    }
    return { stdout: "" };
  };
  return { calls, execFn };
}

const REPO = "/repo";

// ------------------------------------------------------------ branch slug

assert(
  branchSlug([287], "repoRoot is never a dev tree, ever") ===
    "feature/issue-287-reporoot-is-never-a-dev-tree",
  "branchSlug: deterministic slug from the issue title, capped at 6 words",
);
assert(
  branchSlug([85, 111], "shell hardening") === "feature/issues-85-111-shell-hardening",
  "branchSlug: multi-issue cycles get an issues-N-M stem",
);
assert(branchSlug([5], undefined) === "feature/issue-5", "branchSlug: bare stem when no title");
// The #358/#359 regression: the same issue+title must never produce two names.
assert(
  branchSlug([5], "Surface thinking-only model output") ===
    branchSlug([5], "Surface thinking-only model output"),
  "branchSlug: stable across calls — the property an LLM-authored name lacked (#358/#359)",
);

// -------------------------------------------------------- mainline detect

{
  const { execFn } = recorder({ "git symbolic-ref": "origin/develop\n" });
  assert(
    (await detectMainline(execFn, REPO)) === "develop",
    "detectMainline: prefers origin/HEAD over guessing",
  );
}
{
  const { execFn } = recorder({
    "git symbolic-ref": "!THROW!no origin/HEAD",
    'git rev-parse --verify "origin/main"': "abc\n",
  });
  assert(
    (await detectMainline(execFn, REPO)) === "main",
    "detectMainline: falls back to probing origin/main when origin/HEAD is unset",
  );
}

// ------------------------------------------------- mechanized branch setup

{
  const { calls, execFn } = recorder({
    "git symbolic-ref": "origin/main\n",
    'git rev-parse "origin/main"': "deadbeefcafe\n",
  });
  const out = await mechanizedBranchSetup(execFn, REPO, 287, [287], [], "always worktree");

  assert(
    out.worktrees.default === path.join(REPO, ".worktrees", "issue-287-default"),
    "N=1 produces a real .worktrees/issue-287-default path",
  );
  assert(
    path.resolve(out.worktrees.default ?? "") !== path.resolve(REPO),
    "worktrees[id] can never resolve to repoRoot — the #602 precondition",
  );
  assert(
    out.baseSha === "deadbeefcafe",
    "baseSha resolved from origin/<mainline>, not repoRoot HEAD",
  );
  assert(
    calls.some((c) => c.cmd.includes("git worktree add") && c.cmd.includes("--detach")),
    "worktrees are created DETACHED — no scratch branch per workstream",
  );
  assert(
    !calls.some((c) => c.cmd.startsWith("git checkout") || c.cmd.startsWith("git pull")),
    "branch setup never checks out or pulls at repoRoot — the operator's tree is untouched",
  );
  // `git fetch` mutates refs only, never the working tree, so it is the one
  // repoRoot command the branch step is allowed to make.
  const mutating = calls.filter(
    (c) =>
      path.resolve(c.cwd || REPO) === path.resolve(REPO) &&
      !/^git (fetch|rev-parse|symbolic-ref|worktree)/.test(c.cmd),
  );
  assert(
    mutating.length === 0,
    `branch step runs no tree-mutating git at repoRoot (saw ${mutating.length})`,
  );
}

{
  const { calls, execFn } = recorder({
    "git symbolic-ref": "origin/main\n",
    'git rev-parse "origin/main"': "base1\n",
  });
  const out = await mechanizedBranchSetup(execFn, REPO, 553, [553], ["task-a", "task-b"], "multi");
  assert(
    Object.keys(out.worktrees).length === 2 &&
      out.worktrees["task-a"]?.endsWith("issue-553-task-a") === true,
    "N>1 produces one worktree per workstream",
  );
  assert(
    calls.filter((c) => c.cmd.includes("git worktree add")).length === 2,
    "N>1 creates exactly one worktree per workstream",
  );
}

{
  const { execFn } = recorder({
    "git symbolic-ref": "origin/main\n",
    'git rev-parse "origin/main"': "\n", // unresolvable base
  });
  let threw = false;
  await mechanizedBranchSetup(execFn, REPO, 1, [1], [], "x").catch(() => {
    threw = true;
  });
  assert(threw, "unresolvable base SHA throws so the caller can route to a handoff");
}

// --------------------------------------------------------------- integrate

const INTEGRATE_BASE = {
  repoRoot: REPO,
  branchName: "feature/issue-287-x",
  baseSha: "base1",
  worktrees: { default: "/repo/.worktrees/issue-287-default" },
  scratchDir: mkdtempSync(path.join(tmpdir(), "integrate-")),
  commitTitle: "t",
  commitBody: "b",
} as const;

{
  // Dirty repoRoot must block integration — #283's gate, relocated. This is
  // what stops operator residue riding into the PR.
  const { execFn } = recorder({ "git status --porcelain": " M src/operator-wip.ts\n" });
  const res = await integrate(execFn, { ...INTEGRATE_BASE, mode: "create" });
  assert(
    !res.ok && /uncommitted changes/.test(res.reason) && /operator-wip/.test(res.reason),
    "integrate: dirty repoRoot refuses to integrate and names the offending files",
  );
}

{
  const calls: Array<{ cmd: string; cwd: string }> = [];
  const execFn: ExecFn = async (cmd, o) => {
    const cwd = o?.cwd ?? "";
    calls.push({ cmd, cwd });
    if (cmd.startsWith("git status --porcelain")) {
      return { stdout: cwd === REPO ? "" : " M src/a.ts\n" };
    }
    if (cmd.startsWith("git diff --cached")) return { stdout: "diff --git a/a b/a\n+x\n" };
    return { stdout: "" };
  };
  const res = await integrate(execFn, { ...INTEGRATE_BASE, mode: "create" });
  assert(res.ok && !res.empty, "integrate: clean repoRoot + dirty worktree consolidates");

  const checkoutIdx = calls.findIndex((c) => c.cmd.startsWith("git checkout -B"));
  const applyIdx = calls.findIndex((c) => c.cmd.startsWith("git apply"));
  const commitIdx = calls.findIndex((c) => c.cmd.startsWith("git commit"));
  const pushIdx = calls.findIndex((c) => c.cmd.startsWith("git push"));
  assert(
    calls[checkoutIdx]?.cmd.includes('"base1"') === true,
    "integrate: branch is created at the recorded baseSha, not at repoRoot HEAD",
  );
  assert(
    checkoutIdx >= 0 && checkoutIdx < applyIdx && applyIdx < commitIdx && commitIdx < pushIdx,
    "integrate: checkout -B → apply → commit → push, in that order",
  );
  assert(
    calls.some((c) => c.cmd.startsWith("git diff --cached") && c.cwd !== REPO),
    "integrate: the slice is captured FROM the worktree, not from repoRoot",
  );
}

{
  // A partial consolidation is the v0.12.13 incident (1 of 3 workstreams
  // shipped, issue closed, root fix lost). commit-pr must refuse it.
  const execFn: ExecFn = async (cmd, o) => {
    const cwd = o?.cwd ?? "";
    if (cmd.startsWith("git status --porcelain")) {
      if (cwd === REPO) return { stdout: "" };
      return { stdout: cwd.endsWith("b") ? "" : " M src/a.ts\n" };
    }
    if (cmd.startsWith("git diff --cached")) return { stdout: "diff --git a/a b/a\n+x\n" };
    return { stdout: "" };
  };
  const worktrees = { a: "/repo/.worktrees/a", b: "/repo/.worktrees/b" };
  const strict = await integrate(execFn, {
    ...INTEGRATE_BASE,
    worktrees,
    mode: "create",
    requireAllNonEmpty: true,
  });
  assert(
    !strict.ok && /no uncommitted work/.test(strict.reason),
    "integrate: requireAllNonEmpty refuses to ship a partial consolidation",
  );
  const lenient = await integrate(execFn, { ...INTEGRATE_BASE, worktrees, mode: "followup" });
  assert(
    lenient.ok && !lenient.empty,
    "integrate: followup mode (lens-fix) tolerates a worktree with no changes",
  );
}

{
  // Apply conflicts must surface the patch path so the operator can inspect it.
  const execFn: ExecFn = async (cmd, o) => {
    const cwd = o?.cwd ?? "";
    if (cmd.startsWith("git status --porcelain"))
      return { stdout: cwd === REPO ? "" : " M src/a.ts\n" };
    if (cmd.startsWith("git diff --cached")) return { stdout: "diff --git a/a b/a\n+x\n" };
    if (cmd.startsWith("git apply")) throw new Error("patch does not apply");
    return { stdout: "" };
  };
  const res = await integrate(execFn, { ...INTEGRATE_BASE, mode: "create" });
  assert(
    !res.ok && /git apply failed/.test(res.reason) && Boolean(res.conflictPatch),
    "integrate: apply conflict reports the preserved patch path",
  );
}

{
  // followup mode stays on the branch instead of recreating it — recreating
  // would discard the commits the first integration already made.
  const calls: Array<string> = [];
  const execFn: ExecFn = async (cmd, o) => {
    calls.push(cmd);
    const cwd = o?.cwd ?? "";
    if (cmd.startsWith("git status --porcelain"))
      return { stdout: cwd === REPO ? "" : " M src/a.ts\n" };
    if (cmd.startsWith("git diff --cached")) return { stdout: "diff --git a/a b/a\n+x\n" };
    return { stdout: "" };
  };
  await integrate(execFn, { ...INTEGRATE_BASE, mode: "followup" });
  assert(
    calls.some((c) => c.startsWith("git checkout ")) &&
      !calls.some((c) => c.startsWith("git checkout -B")),
    "integrate: followup checks out the branch, never re-creates it",
  );
}

rmSync(INTEGRATE_BASE.scratchDir, { recursive: true, force: true });

console.log(`\nexit ${exit}`);
process.exit(exit);
