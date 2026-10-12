#!/usr/bin/env bun
/**
 * #1016 — the dependent phase's one-shot retry and its persisted worktree path.
 *  1. A dependent that fails its first pass and recovers on the retry appears
 *     exactly once in the verdicts, ok:true (the first pass's stale entry is gone).
 *  2. A persisted dependent worktree path outside `.worktrees/` is refused
 *     (fail closed): no dispatch, a failed verdict naming the refusal.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { runDependentWorkstreams } from "../src/work-develop-run.ts";
import { execp } from "../src/work-driver-verify.ts";
import { type WorkEvent, initialState } from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const git = (cwd: string, args: string[]): string =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-1016-dep-"));

/** A repo with a base commit, and a dependency worktree one commit ahead of it. */
function fixture(name: string): { repo: string; baseSha: string; depWt: string; depHead: string } {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  git(repo, ["init", "-q", "--initial-branch=main"]);
  git(repo, ["add", "a.txt"]);
  git(repo, ["commit", "-qm", "base"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  const depWt = path.join(repo, ".worktrees", "issue-1016-task-a");
  git(repo, ["worktree", "add", "-q", "--detach", depWt, baseSha]);
  writeFileSync(path.join(depWt, "a.txt"), "base\ndep work\n");
  git(depWt, ["commit", "-qam", "dep work"]);
  return { repo, baseSha, depWt, depHead: git(depWt, ["rev-parse", "HEAD"]) };
}

/** The driver context the dependent phase reads: repoRoot and issue only (the
 * dispatch itself is the injected runOne, never the pi binding). */
function ctxFor(repo: string): DriverContext {
  const stub = {
    issue: 1016,
    issues: [1016],
    repoRoot: repo,
    verifyExecFn: execp,
    stateRef: { current: initialState(1016) },
  };
  return stub as unknown as DriverContext;
}

const ws = {
  "task-a": { id: "task-a", scope: "dep", paths: [], outOfScope: [] },
  "task-b": { id: "task-b", scope: "dependent", paths: [], outOfScope: [], dependsOn: ["task-a"] },
};

// ------------------------------------------ 1. recovered dependent, one verdict
{
  const { repo, baseSha, depWt, depHead } = fixture("recovered");
  const worktrees: Record<string, string> = { "task-a": depWt };
  const workstreamBaseShas: Record<string, string> = { "task-a": baseSha };
  const verdicts: Array<{ id: string; ok: boolean; reason?: string }> = [];
  const branchEvents: WorkEvent[] = [];
  const failedOrSkipped = new Set<string>();
  const stateRef = { current: initialState(1016) };
  let calls = 0;
  // Mirrors runOneWorkstream: each dispatch pushes its own verdict into the list.
  const runOne = async (id: string, cwd: string) => {
    calls++;
    if (calls === 1) {
      verdicts.push({ id, ok: false, reason: "first pass failed" });
      return { id, ok: false, reason: "first pass failed" };
    }
    writeFileSync(path.join(cwd, "b.txt"), "retry work\n");
    git(cwd, ["add", "b.txt"]);
    git(cwd, ["commit", "-qm", "retry work"]);
    verdicts.push({ id, ok: true });
    return { id, ok: true };
  };
  const res = await runDependentWorkstreams(
    ctxFor(repo),
    ["task-b"],
    ws,
    { "task-b": ["task-a"] },
    failedOrSkipped,
    verdicts,
    branchEvents,
    execp,
    worktrees,
    workstreamBaseShas,
    baseSha,
    ["task-a", "task-b"],
    runOne,
    {
      stateRef,
      depCompletedAtMap: { "task-a": Date.now() - 1000 },
      resetFor: async () => ({ attempt: 1 }),
      notes: [],
    },
  );
  const bVerdicts = verdicts.filter((v) => v.id === "task-b");
  assert(calls === 2, "#1016: the recovered dependent was dispatched twice (first pass + one retry)");
  assert(bVerdicts.length === 1, `#1016: a recovered dependent appears once (got ${bVerdicts.length})`);
  assert(bVerdicts[0]?.ok === true, "#1016: the recovered dependent's single verdict is ok:true");
  assert(
    existsSync(path.join(res.worktrees["task-b"] ?? "", "b.txt")),
    "#1016: retry work is in its worktree",
  );
  assert(depHead.length === 40, "#1016: fixture dependency has a commit");
}

// --------------------- 2. a persisted dependent path outside .worktrees/ is refused
{
  const { repo, baseSha, depWt } = fixture("refused");
  const outside = path.join(root, "outside-dir");
  mkdirSync(outside, { recursive: true });
  const worktrees: Record<string, string> = { "task-a": depWt, "task-b": outside };
  const workstreamBaseShas: Record<string, string> = { "task-a": baseSha };
  const verdicts: Array<{ id: string; ok: boolean; reason?: string }> = [];
  let dispatched = 0;
  await runDependentWorkstreams(
    ctxFor(repo),
    ["task-b"],
    ws,
    { "task-b": ["task-a"] },
    new Set<string>(),
    verdicts,
    [],
    execp,
    worktrees,
    workstreamBaseShas,
    baseSha,
    ["task-a", "task-b"],
    async (id) => {
      dispatched++;
      return { id, ok: true };
    },
    { stateRef: { current: initialState(1016) } },
  );
  const v = verdicts.find((x) => x.id === "task-b");
  assert(dispatched === 0, "#1016: a dependent with an outside persisted path is not dispatched");
  assert(
    v?.ok === false && (v.reason ?? "").includes("persisted worktree path refused"),
    `#1016: the refusal is a failed verdict naming the path (got ${JSON.stringify(v)})`,
  );
}

rmSync(root, { recursive: true, force: true });
if (exit !== 0) process.exit(1);
console.log("all #1016 dependent-phase assertions passed");
