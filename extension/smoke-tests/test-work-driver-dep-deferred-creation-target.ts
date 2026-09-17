#!/usr/bin/env bun
/**
 * #753 (six-lens) — case 5 (target-path dirty guard fires in-cycle) and
 * case 6 (sibling events survive the park, cap-hit remains the tail).
 * Split from test-work-driver-dep-deferred-creation.ts for the 500-line cap.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runDependentWorkstreams } from "../src/work-develop-run.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { nextStep } from "../src/work-driver-context.ts";
import { createDependentWorktree } from "../src/work-driver-dep-scheduler.ts";
import { type WorkEvent, initialState } from "../src/workflow-state.ts";
import { runCreateGuards } from "../src/worktree-create-guard.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    console.error(`  (cond was: ${JSON.stringify(cond)})`);
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

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-753-target-"));

async function fixture(tag: string) {
  const repo = path.join(root, tag, "repo");
  mkdirSync(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "user.email", "t@t.co"]);
  await git(repo, ["config", "user.name", "T"]);
  writeFileSync(path.join(repo, "f.txt"), "x\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "init"]);
  const baseSha = (await git(repo, ["rev-parse", "HEAD"])).stdout.trim();
  const wt = path.join(repo, ".worktrees", "issue-753-task-a");
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "a.txt"), "a\n");
  await git(wt, ["add", "."]);
  await git(wt, ["commit", "-m", "task-a work"]);
  return { repo, baseSha, depWt: wt };
}

function ctxFor(repo: string): DriverContext {
  const fixture = {
    pi: {},
    issue: 753,
    issues: [753],
    repoRoot: repo,
    verifyExecFn: realExec,
    stateRef: { current: initialState(753) },
  };
  return fixture as unknown as DriverContext;
}

function makeRunOne(called: boolean[], worktrees: Record<string, string>) {
  return async (id: string, cwd: string) => {
    called.push(true);
    worktrees[id] = cwd;
    return { id, ok: true };
  };
}

// ------------------------------------------------ case 5: TARGET path in-cycle + dirty
// FIX 2 [HIGH ×2]: the in-cycle skip must NOT remove the #475 dirty guard at
// the TARGET path. Case 4 covers the SIBLING scan (exclusion there is the
// genuine #753 fix); this case covers the target. Before the split, an
// in-cycle dirty target produced a generic create-error (the guard was
// skipped) instead of the descriptive DirtyWorktreeError finding.
{
  const { repo, baseSha, depWt } = await fixture("target-dirty");
  // The target path (issue-753-task-b) pre-exists as a registered worktree,
  // is dirty, AND is in-cycle (like task-a: created by the branch step).
  const target = path.join(repo, ".worktrees", "issue-753-task-b");
  await git(repo, ["worktree", "add", "-q", "--detach", target, baseSha]);
  writeFileSync(path.join(target, "leftover.txt"), "uncommitted work\n");

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
    {
      stateRef,
      depCompletedAtMap: { "task-a": Date.now() - 1000 },
      // The target is in-cycle (the branch step created it, and its worktree
      // is registered in `git worktree list`) — exactly the shape that made
      // the old code skip the dirty guard.
      inCycleWorktrees: [depWt, target],
    },
  );
  // The #475 dirty guard fires (park), not a generic create-error.
  assert(
    res.parked === true,
    "#753 case 5: a dirty TARGET path that is in-cycle still PARKS (the #475 guard is not waived by in-cycle membership)",
  );
  const cap = stateRef.current.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    cap?.kind === "cap-hit" && cap.cap === "deferred-creation:develop",
    "#753 case 5: the park is the deferred-creation cap-hit (not a create-error that would not park)",
  );
  const bc = branchEvents.find(
    (e): e is Extract<WorkEvent, { kind: "branch-completed" }> =>
      e.kind === "branch-completed" && e.workstreamId === "task-b",
  );
  assert(
    bc?.deferredCreation?.failure?.class === "dirty-leftover",
    "#753 case 5: the branch-completed event records a dirty-leftover (the descriptive finding), not a create-error",
  );
  assert(
    bc?.deferredCreation?.failure?.class === "dirty-leftover" &&
      bc.deferredCreation.failure.leftoverPath === target &&
      bc.error?.includes("refused") === true &&
      bc.error?.includes(target) === true,
    `#753 case 5: the dirty finding names the target path AND the error is the descriptive refusal text (not a generic git add failure) (got: ${bc?.error?.slice(0, 80)})`,
  );
  // The dirty leftover is still on disk — nothing was force-removed.
  const { stdout: leftoverStatus } = await git(target, ["status", "--porcelain"]);
  assert(
    leftoverStatus.includes("leftover.txt"),
    "#753 case 5: the dirty leftover is still on disk (NOT force-removed)",
  );
}

// ------------------------------------------------ case 6: sibling survives the park
// #753 (six-lens FIX 6): when the dependent phase parks on a dirty leftover,
// the INDEPENDENT phase's results (the sibling's branch-completed event) must
// survive in the durable event log. The pre-fix park short-circuit returned
// before the caller flushed `branchEvents`, so sibling results lived only in
// child transcripts. The cap-hit must STILL be the tail (the step router
// routes on the tail).
//
// Drives the FULL topological develop (independent task-a dispatched as a
// success, then dependent task-b parks) — the shape where sibling events
// exist in branchEvents.
{
  const { repo, baseSha, depWt } = await fixture("sibling-survives");
  // Force task-b's deferred creation to fail (dirty leftover at its target).
  const depTarget = path.join(repo, ".worktrees", "issue-753-task-b");
  mkdirSync(depTarget, { recursive: true });
  await git(repo, ["worktree", "add", "-q", "--detach", depTarget, baseSha]);
  writeFileSync(path.join(depTarget, "leftover.txt"), "uncommitted work\n");

  const worktrees: Record<string, string> = { "task-a": depWt };
  const workstreamBaseShas = { "task-a": baseSha };
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
  const baseState = initialState(753);
  baseState.pipelineState.worktrees = { "task-a": depWt };
  baseState.pipelineState.workstreamBaseShas = { "task-a": baseSha };
  baseState.pipelineState.baseSha = baseSha;
  const stateRef = { current: baseState };
  const ctx = ctxFor(repo);
  // A fake dispatch that records the independent task-a as a success (the
  // dependent task-b is never dispatched — creation fails first).
  const fakeDispatch = async () => ({
    ok: true,
    text: "done",
    ms: 1,
    jobId: "task-a",
    role: "developer",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    transcriptPath: "/tmp/x",
    tokens: 2,
  });
  const dispatchFn = fakeDispatch as unknown as NonNullable<DriverContext["dispatchFn"]>;
  const topResult = await import("../src/work-develop-topological.ts");
  const after = await topResult.runDevelopTopological(
    { ...ctx, dispatchFn } as unknown as DriverContext,
    stateRef.current,
    ["task-a", "task-b"],
    ws,
    [753],
    dispatchFn,
    realExec,
    Date.now(),
    "job-1",
  );
  // The independent sibling's branch-completed event survived in the durable
  // log (the park short-circuit no longer drops it).
  assert(
    after.eventLog.some(
      (e) => e.kind === "branch-completed" && e.workstreamId === "task-a" && e.ok === true,
    ),
    "#753 case 6 (FIX 6): the independent sibling's branch-completed event survives in the durable event log on a dirty-leftover park",
  );
  // The cap-hit is still the tail (the step router routes on the tail).
  const tail = after.eventLog[after.eventLog.length - 1];
  assert(
    tail?.kind === "cap-hit" && tail.cap === "deferred-creation:develop",
    "#753 case 6 (FIX 6): the cap-hit is still the event-log tail after the sibling flush",
  );
  // The routing follows the cap-hit (it was not displaced by the sibling events).
  const parkedState = after;
  parkedState.pipelineState.currentStep = "develop";
  const decision = nextStep(parkedState);
  assert(
    decision.kind === "step" && decision.step === "handoff",
    "#753 case 6 (FIX 6): nextStep still routes to handoff on the cap-hit (it remains the tail)",
  );
}

// ----------------------------------- case 3b: create-error carries the real git stderr
// #753 (six-lens FIX 1): a genuine `git worktree add` failure (unresolvable
// ref, real git stderr) must land in `failure.stderr` via `gitErrorDetail`
// — and `failure.error` must NOT duplicate it. Without the fix, `stderr`
// is undefined (the wrapper drops the rejection's stderr) and `error` is
// the wrapper ("worktreeCreate: … failed: fatal: …"), duplicating the
// fatal line.
{
  const name = path.join(root, "create-error-stderr");
  mkdirSync(name, { recursive: true });
  writeFileSync(path.join(name, "a.txt"), "base\n");
  await git(name, ["init", "-q", "--initial-branch=main"]);
  await git(name, ["config", "user.email", "t@example.com"]);
  await git(name, ["config", "user.name", "T"]);
  await git(name, ["add", "a.txt"]);
  await git(name, ["commit", "-q", "-m", "base"]);
  const { stdout: baseShaOut } = await git(name, ["rev-parse", "HEAD"]);
  const depWt = path.join(name, ".worktrees", "issue-753-task-a");
  await git(name, ["worktree", "add", "-q", "--detach", depWt, baseShaOut.trim()]);
  writeFileSync(path.join(depWt, "a.txt"), "base\ndep work\n");
  await git(depWt, ["add", "a.txt"]);
  await git(depWt, ["commit", "-q", "-m", "dep work"]);
  const res = await createDependentWorktree(realExec, name, 753, "task-b", "nonexistent-ref-00000");
  if (res.path === undefined && res.failure.class === "create-error") {
    const fe = res.failure.stderr ?? "";
    const err = res.failure.error ?? "";
    assert(
      fe === "fatal: invalid reference: nonexistent-ref-00000",
      `#753 case 3b: failure.stderr carries the ACTUAL git stderr, verbatim (no Command-failed wrapper, no duplication) (got: ${JSON.stringify(fe)})`,
    );
    assert(
      err.includes("worktreeCreate:") === true && err.includes(fe) === true && fe !== err,
      `#753 case 3b: failure.error keeps the wrapper context without duplicating stderr verbatim (error: ${JSON.stringify(err)})`,
    );
    assert(
      res.failure.gitCommand?.includes("git worktree add") === true,
      "#753 case 3b: failure.gitCommand names the attempted git worktree add",
    );
    // #753: a genuine `git worktree add` failure must record the REAL
    // numeric exit status (the executor rejection's `code`), not `undefined`
    // and not a hardcode-anything value. An unresolvable ref exits 128
    // (verified: both `sh -c git worktree add …` and `promisify(exec)`
    // reject with `code: 128` for this exact shape).
    assert(
      res.failure.exitStatus === 128,
      `#753 case 3b: failure.exitStatus carries the REAL numeric exit status of the failing git command (expected 128 for an invalid ref; got: ${JSON.stringify(res.failure.exitStatus)})`,
    );
  } else {
    assert(false, "#753 case 3b: the unresolvable ref produced a create-error");
  }
}

// ------------------------------------------------ case 7: sibling scan degrades safely
// #753 (six-lens FIX 2): a transient `git worktree list` failure during the
// sibling scan must NOT escape to a create-error. It degrades to "no
// finding" (creation proceeds exactly as pre-#545), mirroring the
// documented fail-open direction of `scanWorktrees` and
// `inspectWorktreeForLoss`.
{
  const { repo, baseSha } = await (async () => {
    const name = path.join(root, "sibling-scan-degrades");
    mkdirSync(name, { recursive: true });
    writeFileSync(path.join(name, "a.txt"), "x\n");
    await git(name, ["init", "-q", "--initial-branch=main"]);
    await git(name, ["config", "user.email", "t@t.co"]);
    await git(name, ["config", "user.name", "T"]);
    await git(name, ["add", "."]);
    await git(name, ["commit", "-q", "-m", "base"]);
    const sha = (await git(name, ["rev-parse", "HEAD"])).stdout.trim();
    return { repo: name, baseSha: sha };
  })();
  // A sibling worktree that the scan WOULD have caught if the git error
  // did not fire.
  const sibling = path.join(repo, ".worktrees", "issue-753-foreign");
  await git(repo, ["worktree", "add", "-q", "--detach", sibling, baseSha]);
  // Throw on the FIRST `git worktree list` call (the sibling scan) but not
  // the second (the target-path guard does not call `worktree list`, but
  // we throw only once to be safe).
  let listCalls = 0;
  const broken: ExecFn = async (cmd, o) => {
    if (cmd.includes("worktree list")) {
      listCalls++;
      if (listCalls === 1) throw new Error("git: unable to read worktree list");
    }
    return realExec(cmd, o);
  };
  let threw = false;
  try {
    await runCreateGuards(broken, { repoRoot: repo, name: "issue-753-mine", fromRef: baseSha });
  } catch {
    threw = true;
  }
  assert(
    threw === false,
    "#753 case 7: a failing sibling scan degrades to no-finding (guards resolve) — it does NOT escape to a create-error",
  );
  // The sibling worktree is still on disk (the degraded scan did not touch it).
  const { stdout: sibStatus } = await git(sibling, ["status", "--porcelain"]).catch(() => ({
    stdout: "GONE\n",
  }));
  assert(
    sibStatus !== "GONE\n",
    "#753 case 7: the sibling worktree is untouched after the degraded scan (safe, not destructive)",
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
