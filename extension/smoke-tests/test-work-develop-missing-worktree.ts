#!/usr/bin/env bun
/**
 * #746 — a develop-path workstream with NO worktree entry must fail with a
 * named error, never silently fall back to repoRoot (the ctx.repoRoot
 * fallback in runDevelopTopological wrote the #741 stray file at the root).
 *
 * Cases:
 *  1. N=1 (default workstream, empty worktrees map) — dispatch is never
 *     called; the workstream is failed with the named refusal; the
 *     dispatch-failed + branch-completed events are recorded.
 *  2. N>1 — the workstream with the missing worktree is refused, its
 *     sibling WITH a worktree dispatches normally; the dependents of the
 *     failed workstream are skipped (cascade) and the dependents of the
 *     successful sibling proceed.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import type { DispatchResult } from "../src/types.ts";
import { initialState, type WorkState } from "../src/workflow-state.ts";
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

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-746-"));

/** A minimal repo with one committed base and (optionally) a worktree at
 * `.worktrees/issue-746-<suffix>` holding one commit ahead of base. */
async function fixture(
  name: string,
  suffix: string | null,
): Promise<{ repo: string; baseSha: string; wt: string | null }> {
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
  if (!suffix) return { repo, baseSha, wt: null };
  const wt = path.join(repo, ".worktrees", `issue-746-${suffix}`);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, baseSha]);
  writeFileSync(path.join(wt, "a.txt"), "base\nwork\n");
  await git(wt, ["add", "a.txt"]);
  await git(wt, ["commit", "-q", "-m", "work"]);
  return { repo, baseSha, wt };
}

/** A dispatch function that records the (id-independent) specs it is given
 * and always succeeds. Records every spec's cwd so the test can assert the
 * refusal path never produced a dispatch. */
function recordingDispatch(
  calls: Array<{ role: string; cwd?: string }>,
): NonNullable<DriverContext["dispatchFn"]> {
  const fn = async (
    _pi: unknown,
    spec: { role: string; cwd?: string },
  ): Promise<DispatchResult> => {
    calls.push({ role: spec.role, cwd: spec.cwd });
    return {
      role: spec.role,
      ok: true,
      text: "done",
      toolUses: [],
      ms: 1,
      exitCode: 0,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      transcriptPath: "/tmp/x",
    };
  };
  return fn as unknown as NonNullable<DriverContext["dispatchFn"]>;
}

function ctxFor(repo: string, dispatchFn: NonNullable<DriverContext["dispatchFn"]>): DriverContext {
  const fixture: Pick<
    DriverContext,
    "repoRoot" | "issue" | "issues" | "verifyExecFn" | "stateRef" | "dispatchFn"
  > & {
    // biome-ignore lint/suspicious/noExplicitAny: driver fixture — the pi binding is never touched on this path
    pi: any;
  } = {
    pi: {},
    issue: 746,
    issues: [746],
    repoRoot: repo,
    verifyExecFn: realExec,
    stateRef: { current: initialState(746) },
    dispatchFn,
  };
  return fixture as unknown as DriverContext;
}

// ------------------------------------------------ case 1: N=1, default workstream, no worktree
{
  const { repo, baseSha } = await fixture("n1", null);
  const calls: Array<{ role: string; cwd?: string }> = [];
  const dispatchFn = recordingDispatch(calls);
  const ctx = ctxFor(repo, dispatchFn);
  const state: WorkState = {
    ...initialState(746),
    pipelineState: {
      ...initialState(746).pipelineState,
      baseSha,
      worktrees: {}, // #746 — the map has NO entry for "default"
      workstreams: {}, // N=1: ids fall back to ["default"]
      currentStep: "develop",
    },
  };
  const after = await runDevelopTopological(
    ctx,
    state,
    ["default"],
    {},
    [746],
    dispatchFn,
    realExec,
    Date.now(),
    "job-n1",
  );
  // The developer was NEVER dispatched (no worktree → no valid cwd).
  assert(
    calls.length === 0,
    "#746 case 1: no dispatch at all when the default workstream has no worktree (the pre-fix code dispatched with cwd=repoRoot)",
  );
  const df = after.eventLog.find((e) => e.kind === "dispatch-failed");
  assert(
    df?.kind === "dispatch-failed" &&
      df.errorTail?.includes("no worktree recorded for workstream default") === true &&
      df.errorTail?.includes("falling back to repoRoot") === true,
    `#746 case 1: a dispatch-failed event records the named refusal (got: ${df?.kind === "dispatch-failed" ? df.errorTail : String(df?.kind)})`,
  );
  const bc = after.eventLog.find(
    (e): e is Extract<import("../src/workflow-state.ts").WorkEvent, { kind: "branch-completed" }> =>
      e.kind === "branch-completed" && e.workstreamId === "default",
  );
  assert(
    bc?.ok === false &&
      bc.error?.includes("no worktree recorded for workstream default") === true,
    "#746 case 1: the branch-completed event names the refusal (the router HALTs on this verdict)",
  );
  // The state ends at a cap-hit (the verify gate ran: with no worktree the
  // gate has no evidence and refuses) — the point of this test is that the
  // dispatch itself never happened; the cycle did not proceed as if the
  // workstream had succeeded.
  const tail = after.eventLog[after.eventLog.length - 1];
  assert(
    tail.kind === "cap-hit" && (tail.cap === "verify-failed:develop" || tail.cap.startsWith("verify-failed:")),
    `#746 case 1: the event-log tail is a verify-failed cap (the failed workstream left no evidence), not a success (tail: ${tail.kind}:${tail.kind === "cap-hit" ? tail.cap : ""})`,
  );
  // The worktree dir was never created and the repo root was never written to.
  const { stdout: status } = await git(repo, ["status", "--porcelain"]);
  assert(
    status.trim() === "",
    `#746 case 1: the repo root is still clean (nothing wrote there; got: ${JSON.stringify(status.trim())})`,
  );
}

// ------------------------------------------------ case 2: N>1 — one missing, one present, cascade
{
  const { repo, baseSha, wt } = await fixture("n2", "task-b");
  const calls: Array<{ role: string; cwd?: string }> = [];
  const dispatchFn = recordingDispatch(calls);
  const ctx = ctxFor(repo, dispatchFn);
  const base = initialState(746);
  base.pipelineState.baseSha = baseSha;
  base.pipelineState.worktrees = { "task-b": wt as string }; // task-a absent
  base.pipelineState.workstreamBaseShas = { "task-b": baseSha };
  base.pipelineState.workstreams = {
    "task-a": { id: "task-a", scope: "A", paths: [], outOfScope: [] },
    "task-b": { id: "task-b", scope: "B", paths: [], outOfScope: [] },
    "task-c": {
      id: "task-c",
      scope: "C",
      paths: [],
      outOfScope: [],
      dependsOn: ["task-a", "task-b"],
    },
  };
  base.pipelineState.currentStep = "develop";
  const after = await runDevelopTopological(
    ctx,
    base,
    ["task-a", "task-b", "task-c"],
    base.pipelineState.workstreams,
    [746],
    dispatchFn,
    realExec,
    Date.now(),
    "job-n2",
  );
  // Only the workstream WITH a worktree dispatched, and with its worktree cwd.
  assert(
    calls.length === 1 &&
      calls[0].role === "developer" &&
      calls[0].cwd === wt,
    `#746 case 2: exactly one dispatch (task-b, cwd=its worktree); task-a was refused (calls: ${JSON.stringify(calls)})`,
  );
  // task-a failed with the named refusal.
  const dfA = after.eventLog.find(
    (e): e is Extract<import("../src/workflow-state.ts").WorkEvent, { kind: "branch-completed" }> =>
      e.kind === "branch-completed" && e.workstreamId === "task-a",
  );
  assert(
    dfA?.ok === false &&
      dfA.error?.includes("no worktree recorded for workstream task-a") === true,
    `#746 case 2: task-a's branch-completed names the refusal (got: ${dfA?.error?.slice(0, 100)})`,
  );
  // task-b succeeded.
  const bcB = after.eventLog.find(
    (e): e is Extract<import("../src/workflow-state.ts").WorkEvent, { kind: "branch-completed" }> =>
      e.kind === "branch-completed" && e.workstreamId === "task-b",
  );
  assert(bcB?.ok === true, "#746 case 2: task-b (with a worktree) succeeded");
  // task-c is cascade-skipped because its dependency task-a failed.
  const bcC = after.eventLog.find(
    (e): e is Extract<import("../src/workflow-state.ts").WorkEvent, { kind: "branch-completed" }> =>
      e.kind === "branch-completed" && e.workstreamId === "task-c",
  );
  assert(
    bcC?.ok === false && bcC.error?.includes("task-a") === true,
    `#746 case 2: dependent task-c is cascade-skipped naming its failed dependency task-a (got: ${bcC?.error?.slice(0, 120)})`,
  );
  // No dispatch for task-c (it was skipped, never dispatched).
  assert(
    calls.every((c) => c.cwd !== undefined),
    "#746 case 2: every dispatch carried an explicit cwd (no process-directory fallback)",
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
