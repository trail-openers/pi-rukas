#!/usr/bin/env bun
/**
 * #753 — deferred worktree creation: recording, cascade identity, N=1
 * silence fix, create-error vs dirty-leftover, and in-cycle exclusion.
 * Real git fixture; drives runDependentWorkstreams directly.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runDependentWorkstreams } from "../src/work-develop-run.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { type WorkEvent, initialState } from "../src/workflow-state.ts";
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

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-753-"));

/** A minimal repo with a committed base, plus a dependency worktree that
 * holds ONE real commit ahead of base (so `resolveDependentBase` sees work).
 * Returns the repo root, the base SHA, the dependency worktree path, and the
 * dependency's post-commit HEAD SHA (the fromRef the dependent would create
 * from). */
async function fixture(
  name: string,
): Promise<{ repo: string; baseSha: string; depWt: string; depHeadSha: string }> {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const { stdout: baseShaOut } = await git(repo, ["rev-parse", "HEAD"]);
  const baseSha = baseShaOut.trim();
  const depWt = path.join(repo, ".worktrees", "issue-753-task-a");
  await git(repo, ["worktree", "add", "-q", "--detach", depWt, baseSha]);
  writeFileSync(path.join(depWt, "a.txt"), "base\ndep work\n");
  await git(depWt, ["add", "a.txt"]);
  await git(depWt, ["commit", "-q", "-m", "dep work"]);
  const { stdout: depHeadOut } = await git(depWt, ["rev-parse", "HEAD"]);
  return { repo, baseSha, depWt, depHeadSha: depHeadOut.trim() };
}

/** A minimal DriverContext for runDependentWorkstreams: only repoRoot and
 * issue are read on the deferred-creation path; the dispatch is never called
 * (the workstream is skipped or its creation fails before dispatch). */
function ctxFor(repo: string): DriverContext {
  // The fixture sets only the fields the deferred-creation path reads; the
  // single `unknown` cast is justified by the `pi` stub, while the `Pick`
  // type keeps the four real fields compiler-checked.
  const fixture: Pick<
    DriverContext,
    "repoRoot" | "issue" | "issues" | "verifyExecFn" | "stateRef"
  > & {
    // biome-ignore lint/suspicious/noExplicitAny: driver fixture — the pi binding is never touched on this path
    pi: any;
  } = {
    pi: {},
    issue: 753,
    issues: [753],
    repoRoot: repo,
    verifyExecFn: realExec,
    stateRef: { current: initialState(753) },
  };
  return fixture as unknown as DriverContext;
}

/** A runOneWorkstream that records whether it was called. */
function makeRunOne(called: boolean[], worktrees: Record<string, string>) {
  return async (id: string, cwd: string) => {
    called.push(true);
    worktrees[id] = cwd;
    return { id, ok: true };
  };
}

// ------------------------------------------------------------- case 1: happy
{
  const { repo, baseSha, depWt } = await fixture("happy");
  const worktrees: Record<string, string> = { "task-a": depWt };
  const workstreamBaseShas = { "task-a": baseSha };
  const verdicts: Array<{ id: string; ok: boolean }> = [];
  const branchEvents: WorkEvent[] = [];
  const failedOrSkipped = new Set<string>();
  const called: boolean[] = [];
  const ws = {
    "task-a": { id: "task-a", scope: "dep", paths: [], outOfScope: [] },
    "task-b": {
      id: "task-b",
      scope: "dependent",
      paths: [],
      outOfScope: [],
      dependsOn: ["task-a"],
    },
  };
  const stateRef = { current: initialState(753) };
  const res = await runDependentWorkstreams(
    ctxFor(repo),
    ["task-b"],
    ws,
    { "task-b": ["task-a"] },
    failedOrSkipped,
    verdicts,
    branchEvents,
    realExec,
    worktrees,
    workstreamBaseShas,
    baseSha,
    ["task-a", "task-b"],
    makeRunOne(called, worktrees),
    { stateRef, depCompletedAtMap: { "task-a": Date.now() - 1000 } },
  );
  // The dependent's worktree was created (deferred creation succeeded).
  // The worktree is detached at the dependency's post-commit SHA (not base).
  const depTarget = res.worktrees["task-b"];
  if (depTarget) {
    const { stdout: bHead } = await git(depTarget, ["rev-parse", "HEAD"]);
    const { stdout: depHead } = await git(depWt, ["rev-parse", "HEAD"]);
    assert(
      bHead.trim() === depHead.trim() && bHead.trim() !== baseSha,
      "#753 case 1: the dependent worktree is detached at the dependency's post-commit SHA",
    );
  }
  assert(res.parked === false, "#753 case 1: the happy path does not park");
}

// -------------------------------------------------------- case 2: creation fails
{
  const { repo, baseSha, depWt } = await fixture("fail");
  // Force the dependent's deferred creation to fail: a dirty leftover at its
  // target path (the pre-add guard in worktreeCreate throws DirtyWorktreeError
  // before `git worktree add` runs — the exact shape of the live incidents).
  const depTarget = path.join(repo, ".worktrees", "issue-753-task-b");
  mkdirSync(depTarget, { recursive: true });
  await git(repo, ["worktree", "add", "-q", "--detach", depTarget, baseSha]);
  writeFileSync(path.join(depTarget, "leftover.txt"), "uncommitted work\n");

  const worktrees: Record<string, string> = { "task-a": depWt };
  const workstreamBaseShas = { "task-a": baseSha };
  const verdicts: Array<{ id: string; ok: boolean }> = [];
  const branchEvents: WorkEvent[] = [];
  const failedOrSkipped = new Set<string>();
  const called: boolean[] = [];
  const ws = {
    "task-a": { id: "task-a", scope: "dep", paths: [], outOfScope: [] },
    "task-b": {
      id: "task-b",
      scope: "dependent",
      paths: [],
      outOfScope: [],
      dependsOn: ["task-a"],
    },
  };
  const stateRef = { current: initialState(753) };
  const failResult = await runDependentWorkstreams(
    ctxFor(repo),
    ["task-b"],
    ws,
    { "task-b": ["task-a"] },
    failedOrSkipped,
    verdicts,
    branchEvents,
    realExec,
    worktrees,
    workstreamBaseShas,
    baseSha,
    ["task-a", "task-b"],
    makeRunOne(called, worktrees),
    { stateRef, depCompletedAtMap: { "task-a": Date.now() - 1000 } },
  );
  // The dependent was NOT dispatched (creation failed before dispatch).
  assert(
    called.length === 0,
    "#753 case 2: the dependent was NOT dispatched (creation failed first)",
  );
  // The dirty leftover is still on disk — nothing was force-removed.
  const { stdout: leftoverStatus } = await git(depTarget, ["status", "--porcelain"]);
  assert(
    leftoverStatus.includes("leftover.txt"),
    "#753 case 2: the dirty leftover is still on disk (NOT force-removed)",
  );
  // The branch-completed event carries the underlying failure (the leftover
  // path), the deferral context (which dependency, which base ref), and the
  // depCompletedAt timing field.
  const bc = branchEvents.find(
    (e): e is Extract<WorkEvent, { kind: "branch-completed" }> =>
      e.kind === "branch-completed" && e.workstreamId === "task-b",
  );
  assert(bc !== undefined, "#753 case 2: a branch-completed event was recorded for the dependent");
  assert(bc?.ok === false, "#753 case 2: the dependent's branch-completed event is ok=false");
  assert(
    bc?.error?.includes("leftover") === true || bc?.error?.includes(depTarget) === true,
    "#753 case 2: the error names the dirty leftover (the finding is the record, not a literal)",
  );
  assert(
    bc?.deferredCreation?.waitedFor === "task-a",
    "#753 case 2: the deferral context records which dependency was waited for (task-a)",
  );
  assert(
    bc?.deferredCreation?.resolvedBaseRef !== undefined &&
      bc?.deferredCreation?.resolvedBaseRef?.length === 40,
    "#753 case 2: the deferral context records the base ref the deferred creation resolved to",
  );
  assert(
    bc?.depCompletedAt !== undefined,
    "#753 case 2: the depCompletedAt timing field is recorded on the branch-completed event",
  );
  assert(
    bc?.deferredCreation?.failure?.class === "dirty-leftover",
    "#753 case 2: the failure class is dirty-leftover (a pre-add guard, not a raw git add)",
  );
  assert(
    bc?.deferredCreation?.failure?.leftoverPath?.includes(depTarget) === true,
    "#753 case 2: the dirty-leftover failure names the leftover path",
  );
  // A cap-hit was emitted (the cycle PARKS on a dirty-leftover refusal). It
  // is appended to stateRef.current's event log, not branchEvents.
  const cap = stateRef.current.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap !== undefined,
    "#753 case 2: a cap-hit was emitted (the cycle PARKS on a dirty-leftover refusal)",
  );
  // The cap-hit is the event-log TAIL — the step router routes on the tail,
  // so the caller must short-circuit (parked flag) and not append the
  // branch-completed event or a branches-converged verdict after it.
  const tail = stateRef.current.eventLog[stateRef.current.eventLog.length - 1];
  assert(
    tail?.kind === "cap-hit",
    "#753 case 2: the cap-hit remains the event-log tail (it is the routing signal)",
  );
  // #753 — the cap-hit's cap field is "deferred-creation:develop" (not
  // "step-failed:develop"), so the handoff terminalizes it as a `handoff`
  // (a deliberate park) rather than an `aborted` (a mid-flight crash).
  if (cap && cap.kind === "cap-hit") {
    assert(
      cap.cap === "deferred-creation:develop",
      "#753 case 2: the cap-hit uses 'deferred-creation:develop' (not 'step-failed:develop') — the handoff status will be 'handoff', not 'aborted'",
    );
  }
  // The parked flag and the cap-hit are one structural unit: parked === true
  // IFF a cap-hit is present AND at the tail.
  const capHitCount = stateRef.current.eventLog.filter((e) => e.kind === "cap-hit").length;
  assert(
    (failResult.parked === true && capHitCount === 1 && tail?.kind === "cap-hit") ||
      (failResult.parked === false && capHitCount === 0),
    "#753 case 2: parked flag and cap-hit are structurally coupled (parked=true IFF cap-hit present and at tail)",
  );
  // The ms field keeps its existing meaning (0 for a failed creation, not a
  // repurposed value).
  assert(bc?.ms === 0, "#753 case 2: the ms field keeps its meaning (0 for a failed creation)");
}

// ------------------------------------------- case 2b: cascade identity (N=3)
{
  const { repo, baseSha, depWt } = await fixture("cascade");
  // Force task-b's deferred creation to fail (dirty leftover at its target).
  const depTarget = path.join(repo, ".worktrees", "issue-753-task-b");
  mkdirSync(depTarget, { recursive: true });
  await git(repo, ["worktree", "add", "-q", "--detach", depTarget, baseSha]);
  writeFileSync(path.join(depTarget, "leftover.txt"), "uncommitted work\n");

  const worktrees: Record<string, string> = { "task-a": depWt };
  const workstreamBaseShas = { "task-a": baseSha };
  const verdicts: Array<{ id: string; ok: boolean }> = [];
  const branchEvents: WorkEvent[] = [];
  const failedOrSkipped = new Set<string>();
  const called: boolean[] = [];
  const ws = {
    "task-a": { id: "task-a", scope: "dep", paths: [], outOfScope: [] },
    "task-b": {
      id: "task-b",
      scope: "dependent",
      paths: [],
      outOfScope: [],
      dependsOn: ["task-a"],
    },
    "task-c": {
      id: "task-c",
      scope: "transitive",
      paths: [],
      outOfScope: [],
      dependsOn: ["task-b"],
    },
  };
  const stateRef = { current: initialState(753) };
  // Drive task-b (fails) then task-c (cascades) through the same call.
  await runDependentWorkstreams(
    ctxFor(repo),
    ["task-b", "task-c"],
    ws,
    { "task-b": ["task-a"], "task-c": ["task-b"] },
    failedOrSkipped,
    verdicts,
    branchEvents,
    realExec,
    worktrees,
    workstreamBaseShas,
    baseSha,
    ["task-a", "task-b", "task-c"],
    makeRunOne(called, worktrees),
    { stateRef, depCompletedAtMap: { "task-a": Date.now() - 1000 } },
  );
  // task-b's creation failed (the primary failure).
  const bcB = branchEvents.find(
    (e): e is Extract<WorkEvent, { kind: "branch-completed" }> =>
      e.kind === "branch-completed" && e.workstreamId === "task-b",
  );
  assert(
    bcB !== undefined && bcB.ok === false,
    "#753 cascade: task-b's branch-completed is ok=false",
  );
  assert(
    bcB?.deferredCreation?.failure?.class === "dirty-leftover",
    "#753 cascade: task-b's failure is the deferred-creation failure (the primary failure)",
  );
  // task-c was NOT dispatched (its dependency task-b failed).
  assert(
    called.length === 0,
    "#753 cascade: task-c was NOT dispatched (its dependency task-b failed)",
  );
  // The primary failure is the record: it names the workstream that actually
  // failed (task-b), not a generic "dependency was skipped or failed".
  assert(
    bcB?.error?.includes("task-b") === true,
    "#753 cascade: the primary failure event names the workstream that actually failed (task-b)",
  );
}

// ------------------------------------------- case 3: create-error (non-dirty)
{
  const { repo, baseSha, depWt } = await fixture("create-error");
  // Force the dependent's deferred creation to fail with a non-dirty error:
  // use an unresolvable fromRef that causes `git worktree add` to fail with a
  // plain git error (not a DirtyWorktreeError).
  const worktrees: Record<string, string> = { "task-a": depWt };
  const workstreamBaseShas = { "task-a": baseSha };
  const verdicts: Array<{ id: string; ok: boolean }> = [];
  const branchEvents: WorkEvent[] = [];
  const failedOrSkipped = new Set<string>();
  const called: boolean[] = [];
  const ws = {
    "task-a": { id: "task-a", scope: "dep", paths: [], outOfScope: [] },
    "task-b": {
      id: "task-b",
      scope: "dependent",
      paths: [],
      outOfScope: [],
      dependsOn: ["task-a"],
    },
  };
  const stateRef = { current: initialState(753) };
  // Use a fake execFn that fails on `git worktree add` with a plain error.
  const failingExec: ExecFn = async (cmd, o) => {
    if (cmd.includes("git worktree add")) {
      throw new Error("fatal: invalid reference: nonexistent-ref");
    }
    return realExec(cmd, o);
  };
  const res = await runDependentWorkstreams(
    ctxFor(repo),
    ["task-b"],
    ws,
    { "task-b": ["task-a"] },
    failedOrSkipped,
    verdicts,
    branchEvents,
    failingExec,
    worktrees,
    workstreamBaseShas,
    baseSha,
    ["task-a", "task-b"],
    makeRunOne(called, worktrees),
    { stateRef, depCompletedAtMap: { "task-a": Date.now() - 1000 } },
  );
  // The dependent was NOT dispatched (creation failed before dispatch).
  assert(
    called.length === 0,
    "#753 case 3: the dependent was NOT dispatched (creation failed first)",
  );
  // The cycle did NOT park (create-error is not a park).
  assert(
    res.parked === false,
    "#753 case 3: the cycle did NOT park on a create-error (only dirty-leftover parks)",
  );
  // No cap-hit was emitted (only dirty-leftover emits a cap-hit).
  const capHitCount = stateRef.current.eventLog.filter((e) => e.kind === "cap-hit").length;
  assert(
    capHitCount === 0,
    "#753 case 3: no cap-hit was emitted for a create-error (the PR7 router handles routing)",
  );
  // The branch-completed event was recorded with the create-error class.
  const bc = branchEvents.find(
    (e): e is Extract<WorkEvent, { kind: "branch-completed" }> =>
      e.kind === "branch-completed" && e.workstreamId === "task-b",
  );
  assert(bc !== undefined, "#753 case 3: a branch-completed event was recorded for the dependent");
  assert(bc?.ok === false, "#753 case 3: the dependent's branch-completed event is ok=false");
  assert(
    bc?.deferredCreation?.failure?.class === "create-error",
    "#753 case 3: the failure class is create-error (a git error, not a dirty leftover)",
  );
  assert(
    bc?.deferredCreation?.failure?.error !== undefined,
    "#753 case 3: the create-error carries the underlying error text",
  );
}

// ------------------------------------------- case 4: in-cycle exclusion
{
  const { repo, baseSha, depWt } = await fixture("in-cycle");
  // Create a second worktree that will be "in-cycle" (like task-a), and make
  // it dirty. Then try to create a third worktree — the in-cycle exclusion
  // must NOT prevent the creation from succeeding (the dirty in-cycle
  // worktree is excluded from the scan).
  const inCycleTarget = path.join(repo, ".worktrees", "issue-753-task-c");
  await git(repo, ["worktree", "add", "-q", "--detach", inCycleTarget, baseSha]);
  writeFileSync(path.join(inCycleTarget, "dirty.txt"), "uncommitted work\n");

  const worktrees: Record<string, string> = { "task-a": depWt, "task-c": inCycleTarget };
  const workstreamBaseShas = { "task-a": baseSha, "task-c": baseSha };
  const verdicts: Array<{ id: string; ok: boolean }> = [];
  const branchEvents: WorkEvent[] = [];
  const failedOrSkipped = new Set<string>();
  const called: boolean[] = [];
  const ws = {
    "task-a": { id: "task-a", scope: "dep", paths: [], outOfScope: [] },
    "task-c": { id: "task-c", scope: "dep", paths: [], outOfScope: [] },
    "task-b": {
      id: "task-b",
      scope: "dependent",
      paths: [],
      outOfScope: [],
      dependsOn: ["task-a"],
    },
  };
  const stateRef = { current: initialState(753) };
  const res = await runDependentWorkstreams(
    ctxFor(repo),
    ["task-b"],
    ws,
    { "task-b": ["task-a"] },
    failedOrSkipped,
    verdicts,
    branchEvents,
    realExec,
    worktrees,
    workstreamBaseShas,
    baseSha,
    ["task-a", "task-b", "task-c"],
    makeRunOne(called, worktrees),
    {
      stateRef,
      depCompletedAtMap: { "task-a": Date.now() - 1000 },
      inCycleWorktrees: [depWt, inCycleTarget],
    },
  );
  // The dependent's worktree was created (the in-cycle dirty worktree task-c
  // did NOT block the creation — it was excluded from the scan).
  assert(
    res.worktrees["task-b"] !== undefined && res.worktrees["task-b"] !== "",
    "#753 case 4: the dependent workstream's worktree was created despite a dirty in-cycle worktree (in-cycle exclusion works)",
  );
  assert(
    res.parked === false,
    "#753 case 4: the cycle did not park (in-cycle dirty work is not a leftover)",
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
