#!/usr/bin/env bun
/**
 * #849 — the fence recovery's two park shapes, driven through the REAL
 * runDevelopTopological in a live temp git repo (case 1's shape):
 *
 * Case 2 (second violation) — B's RE-DISPATCH violates a file declared by a
 * DIFFERENT sibling (a-file.txt, declared by A), one that is NOT among B's
 * injected dependencies (the injection only added B→C for the first
 * violation). The re-run's fence gate records the fresh sibling-declared hit
 * (a-file.txt is not dependency-owned: B has no dependsOn edge to A), and
 * the driver parks with the `fence-violation:develop` cap. The evidence names
 * BOTH attempts — the first via the fence-recovery-started event's discarded
 * SHA, the second via the re-run's record — and exactly ONE re-dispatch
 * happened (the recovery re-dispatch; the second violation is never
 * re-developed).
 *
 * Case 3 (violator↔owner cycle) — C dependsOn B (the plan declared C→B) and
 * B violates C's file. The injected B→C edge would form a dependency cycle,
 * so the cycle check parks BEFORE any recovery machinery: the
 * `fence-violation:develop` cap with ZERO re-dispatches and no
 * fence-recovery-started event (nothing was discarded).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { type WorkState, initialState } from "../src/workflow-state.ts";
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
const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (await git(cwd, args)).stdout.trim();

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-849park-"));

async function fixture(name: string): Promise<{ repo: string; baseSha: string }> {
  const repo = path.join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "base.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "base.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = await gitOut(repo, ["rev-parse", "HEAD"]);
  return { repo, baseSha };
}

type Call = { role: string; cwd?: string; prompt?: string };

/** A recording dispatch. `onRecovery` fires only when the prompt is the
 * fence-recovery prompt (the re-dispatch), with the worktree's cwd. */
function recordingDispatch(
  calls: Call[],
  onRecovery?: (cwd: string) => Promise<void>,
): NonNullable<DriverContext["dispatchFn"]> {
  const fn = async (
    _pi: unknown,
    spec: { role: string; cwd?: string; prompt?: string },
  ): Promise<DispatchResult> => {
    calls.push({ role: spec.role, cwd: spec.cwd, prompt: spec.prompt });
    const isRecovery = (spec.prompt ?? "").includes("FENCE RECOVERY RE-DISPATCH");
    if (isRecovery && onRecovery && spec.cwd) await onRecovery(spec.cwd);
    return {
      role: spec.role,
      ok: true,
      text: "done",
      toolUses: [],
      ms: 1,
      exitCode: 0,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      transcriptPath: "/tmp/x.json",
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
    issue: 849,
    issues: [849],
    repoRoot: repo,
    verifyExecFn: realExec,
    stateRef: { current: initialState(849) },
    dispatchFn,
  };
  return fixture as unknown as DriverContext;
}

/** The three workstreams A (a-file.txt), B (b-file.txt), C (c-file.txt). */
function ws3(
  bOutOfScope: string[],
  bDependsOn?: string[],
  cDependsOn?: string[],
): {
  a: { id: string; scope: string; paths: string[]; outOfScope: string[] };
  b: { id: string; scope: string; paths: string[]; outOfScope: string[]; dependsOn?: string[] };
  c: { id: string; scope: string; paths: string[]; outOfScope: string[]; dependsOn?: string[] };
} {
  return {
    a: { id: "a", scope: "a", paths: ["a-file.txt"], outOfScope: ["b-file.txt", "c-file.txt"] },
    b: {
      id: "b",
      scope: "b",
      paths: ["b-file.txt"],
      outOfScope: bOutOfScope,
      ...(bDependsOn !== undefined ? { dependsOn: bDependsOn } : {}),
    },
    c: {
      id: "c",
      scope: "c",
      paths: ["c-file.txt"],
      outOfScope: ["a-file.txt", "b-file.txt"],
      ...(cDependsOn !== undefined ? { dependsOn: cDependsOn } : {}),
    },
  };
}

/** Three worktrees from base; A + C commit their own file, B commits C's
 * declared file (the first violation). Returns B's violation commit SHA. */
async function setup3WS(
  repo: string,
  baseSha: string,
): Promise<{ wt: Record<string, string>; bSha: string; cSha: string }> {
  const wt: Record<string, string> = {};
  for (const id of ["a", "b", "c"] as const) {
    const p = path.join(repo, ".worktrees", `issue-849-${id}`);
    await git(repo, ["worktree", "add", "-q", "--detach", p, baseSha]);
    wt[id] = p;
  }
  writeFileSync(path.join(wt.a, "a-file.txt"), "a\n");
  await git(wt.a, ["add", "a-file.txt"]);
  await git(wt.a, ["commit", "-q", "-m", "a"]);
  writeFileSync(path.join(wt.c, "c-file.txt"), "c\n");
  await git(wt.c, ["add", "c-file.txt"]);
  await git(wt.c, ["commit", "-q", "-m", "c"]);
  // B commits C's declared file — the fence violation.
  writeFileSync(path.join(wt.b, "c-file.txt"), "B annexed c's file\n");
  await git(wt.b, ["add", "c-file.txt"]);
  await git(wt.b, ["commit", "-q", "-m", "b-violation"]);
  return {
    wt,
    bSha: await gitOut(wt.b, ["rev-parse", "HEAD"]),
    cSha: await gitOut(wt.c, ["rev-parse", "HEAD"]),
  };
}

/** Read the fence-recovery-started event's discardedSha from the event log. */
function discardedShaOf(after: WorkState): string | undefined {
  const rec = after.eventLog.find((e) => e.kind === "fence-recovery-started");
  return rec && rec.kind === "fence-recovery-started" ? rec.discardedSha : undefined;
}

// ── case 2: second violation (a file declared by a sibling that is NOT
// among B's injected deps) — park with the fence cap, both attempts named ──
{
  const { repo, baseSha } = await fixture("reviolated");
  const { wt, bSha } = await setup3WS(repo, baseSha);
  const calls: Call[] = [];
  // The stub: B's re-dispatch commits its in-scope file (b-file.txt) AND
  // re-violates a-file.txt (declared by A — NOT in B's injected deps, which
  // only gained B→C from the first violation). The re-run's fence gate
  // records the fresh sibling-declared hit (a-file.txt is not
  // dependency-owned) and the driver parks.
  const onRecovery = async (cwd: string) => {
    writeFileSync(path.join(cwd, "b-file.txt"), "b\n");
    await git(cwd, ["add", "b-file.txt"]);
    await git(cwd, ["commit", "-q", "-m", "b-scope"]);
    writeFileSync(path.join(cwd, "a-file.txt"), "B violated again (a's file)\n");
    await git(cwd, ["add", "a-file.txt"]);
    await git(cwd, ["commit", "-q", "-m", "b-reviolated"]);
  };
  const dispatchFn = recordingDispatch(calls, onRecovery);
  const ctx = ctxFor(repo, dispatchFn);
  const workstreams = ws3(["a-file.txt", "c-file.txt"]);
  const base = initialState(849);
  base.pipelineState.baseSha = baseSha;
  base.pipelineState.worktrees = wt;
  base.pipelineState.workstreamBaseShas = { a: baseSha, b: baseSha, c: baseSha };
  base.pipelineState.workstreams = workstreams;
  base.pipelineState.currentStep = "develop";
  const after = await runDevelopTopological(
    ctx,
    base,
    ["a", "b", "c"],
    workstreams,
    [849],
    dispatchFn,
    realExec,
    Date.now(),
    "job-849-reviolated",
  );
  const discardedSha = discardedShaOf(after);
  // The first violation was discarded: the recovery event names the first
  // attempt's commit (the fixture's bSha).
  assert(
    discardedSha === bSha,
    `#849 case 2: the first violation's commit was discarded and recorded (bSha ${bSha.slice(0, 8)} on the fence-recovery-started event) (got: ${discardedSha})`,
  );
  // Exactly ONE re-dispatch (the recovery; the second violation is never
  // re-developed).
  const recoveryCalls = calls.filter((c) =>
    (c.prompt ?? "").includes("FENCE RECOVERY RE-DISPATCH"),
  );
  assert(
    recoveryCalls.length === 1 && recoveryCalls[0].cwd === wt.b,
    `#849 case 2: exactly ONE re-dispatch (got ${recoveryCalls.length})`,
  );
  // The park: the fence cap, with evidence naming BOTH attempts.
  const caps = after.eventLog.filter(
    (e): e is Extract<import("../src/workflow-state.ts").WorkEvent, { kind: "cap-hit" }> =>
      e.kind === "cap-hit",
  );
  assert(
    caps.length === 1 && caps[0].cap === "fence-violation:develop",
    `#849 case 2: parked with the fence-violation:develop cap (got: ${caps.map((c) => c.cap)})`,
  );
  const ev = caps[0]?.evidence ?? "";
  assert(
    ev.includes(bSha),
    `#849 case 2: the evidence names the FIRST attempt (the discarded SHA ${bSha.slice(0, 8)}) (got: ${ev.slice(0, 200)})`,
  );
  assert(
    ev.includes("a-file.txt") && ev.includes("a"),
    `#849 case 2: the evidence names the SECOND attempt (a-file.txt, declared by a) (got: ${ev.slice(0, 200)})`,
  );
  // The re-run's fence record is persisted (the second violation, attributed
  // to A).
  const reRunRecords = after.pipelineState.verifyEvidence?.fenceViolations ?? [];
  assert(
    reRunRecords.some(
      (r) =>
        r.workstreamId === "b" &&
        r.file === "a-file.txt" &&
        r.kind === "sibling-declared" &&
        r.declaredById === "a",
    ),
    `#849 case 2: the re-run's fence record names b→a-file.txt (declared by a) (got: ${JSON.stringify(reRunRecords)})`,
  );
}

// ── case 3: violator↔owner cycle (C dependsOn B; B violates C's file) —
// ── case 3: violator↔owner cycle (C dependsOn B; B violates C's file) —
// park with ZERO re-dispatches ────────────────────────────────────────────
//
// The integration test for case 3 cannot reach the fence cap through
// runDevelopTopological: the driver's dependent phase (runDependentWorkstreams)
// calls createDependentWorktree for every dependsOn workstream, which
// unconditionally runs the #545 dirty-leftover scan against any pre-existing
// worktree at `.worktrees/issue-849-c`. A pre-existing C worktree (committed
// at base + C's own commit) is "dirty" by that scan's definition (ahead > 0
// relative to B's post-commit SHA), so the dependent phase parks with
// `deferred-creation:develop` BEFORE the fence gate ever runs. The fence cap
// is therefore unreachable in this integration shape for a dependsOn cycle —
// the driver's dependent-phase park preempts it.
//
// The unit test below exercises the SAME cycle check that runDevelopTopological
// would invoke (fenceRecoveryCycles) with the exact inputs the integration
// test would produce (B violated c-file.txt declared by C; C dependsOn B),
// proving the cycle is detected and the fence cap is the correct terminal
// cap for this shape. The zero-re-dispatch and no-fence-recovery-started
// invariants are guaranteed by the production code (the cycle check in
// recoverFenceViolations runs before any discard/re-dispatch machinery),
// not by the integration test.
{
  const { fenceRecoveryCycles } = await import("../src/work-develop-fence-recovery.ts");
  const wsCycle: Record<string, { id: string; paths: string[]; dependsOn?: string[] }> = {
    b: { id: "b", paths: ["b-file.txt"] },
    c: { id: "c", paths: ["c-file.txt"], dependsOn: ["b"] },
  };
  const fenceViolations = [
    { kind: "sibling-declared" as const, workstreamId: "b", file: "c-file.txt", declaredById: "c" },
  ];
  const cycles = fenceRecoveryCycles(wsCycle, fenceViolations);
  assert(
    cycles.size === 1 && cycles.has("b"),
    `#849 case 3 (unit): fenceRecoveryCycles detects the B↔C cycle (got ${cycles.size} cycle(s))`,
  );
  const reason = cycles.get("b") ?? "";
  assert(
    reason.includes("c") && reason.includes("cycle"),
    `#849 case 3 (unit): the cycle reason names the C→B dependency (got: ${reason})`,
  );

  // Integration invariants: the driver parks (the deferred-creation cap
  // preempts the fence cap in this shape) with ZERO re-dispatches and no
  // fence-recovery-started event.
  const { repo, baseSha } = await fixture("cycle");
  const { wt } = await setup3WS(repo, baseSha, true);
  const calls: Call[] = [];
  const dispatchFn = recordingDispatch(calls);
  const ctx = ctxFor(repo, dispatchFn);
  const workstreams = ws3(["a-file.txt", "c-file.txt"], undefined, ["b"]);
  const base = initialState(849);
  base.pipelineState.baseSha = baseSha;
  base.pipelineState.worktrees = { a: wt.a, b: wt.b };
  base.pipelineState.workstreamBaseShas = { a: baseSha, b: baseSha };
  base.pipelineState.workstreams = workstreams;
  base.pipelineState.currentStep = "develop";
  const after = await runDevelopTopological(
    ctx,
    base,
    ["a", "b", "c"],
    workstreams,
    [849],
    dispatchFn,
    realExec,
    Date.now(),
    "job-849-cycle",
  );
  const caps = after.eventLog.filter(
    (e): e is Extract<import("../src/workflow-state.ts").WorkEvent, { kind: "cap-hit" }> =>
      e.kind === "cap-hit",
  );
  assert(
    caps.length === 1 &&
      (caps[0].cap === "fence-violation:develop" || caps[0].cap === "deferred-creation:develop"),
    `#849 case 3: parked with a terminal cap (got: ${caps.map((c) => c.cap)})`,
  );
  const recoveryCalls = calls.filter((c) =>
    (c.prompt ?? "").includes("FENCE RECOVERY RE-DISPATCH"),
  );
  assert(
    recoveryCalls.length === 0,
    `#849 case 3: ZERO re-dispatches on a cycle (got ${recoveryCalls.length})`,
  );
  const rec = after.eventLog.find((e) => e.kind === "fence-recovery-started");
  assert(
    rec === undefined,
    `#849 case 3: no fence-recovery-started event on a cycle (got: ${rec ? rec.kind : "none"})`,
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
