#!/usr/bin/env bun
/**
 * #849 — the fence recovery's two park shapes, driven through the REAL
 * runDevelopTopological in a live temp git repo (case 1's shape):
 *
 * Case 2 (second violation) — B's MERGE-AND-RETRY violates a file declared by a
 * DIFFERENT sibling (a-file.txt, declared by A), one that is NOT among B's
 * injected dependencies (the injection only added B→C for the first
 * violation). The re-run's fence gate records the fresh sibling-declared hit
 * (a-file.txt is not dependency-owned: B has no dependsOn edge to A), and
 * the driver parks with the `fence-violation:develop` cap. The evidence names
 * BOTH attempts — the first via the fence-recovery-started event's discarded
 * SHA, the second via the re-run's record — and exactly ONE merge-and-retry
 * happened (the merge-and-retry; the second violation is never
 * re-developed).
 *
 * Case 3 (violator↔owner cycle) — C dependsOn B (the plan declared C→B) and
 * B violates C's file. The injected B→C edge would form a dependency cycle,
 * so the cycle check parks BEFORE any recovery machinery: the
 * `fence-violation:develop` cap with ZERO merge-and-retries and no
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
 * fence merge-and-retry prompt (the merge-and-retry), with the worktree's cwd.
 * #1005 — the prompt changed from "FENCE RECOVERY RE-DISPATCH" (the #849
 * recovery) to "FENCE MERGE-AND-RETRY" (the merge-and-retry); the
 * discriminator is the merge prompt. */
function recordingDispatch(
  calls: Call[],
  onRecovery?: (cwd: string) => Promise<void>,
): NonNullable<DriverContext["dispatchFn"]> {
  const fn = async (
    _pi: unknown,
    spec: { role: string; cwd?: string; prompt?: string },
  ): Promise<DispatchResult> => {
    calls.push({ role: spec.role, cwd: spec.cwd, prompt: spec.prompt });
    const isRecovery = (spec.prompt ?? "").includes("FENCE MERGE-AND-RETRY");
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
 * declared file (the first violation). Returns B's violation commit SHA.
 * `skipCWorktree` (case 3) omits C's worktree: C dependsOn B, so its
 * deferred worktree creation (createDependentWorktree) runs against a
 * missing path and fails with a clean create-error — the dependent-phase
 * park that preempts the fence gate for this shape. */
async function setup3WS(
  repo: string,
  baseSha: string,
  skipCWorktree = false,
): Promise<{ wt: Record<string, string>; bSha: string; cSha: string }> {
  const wt: Record<string, string> = {};
  for (const id of ["a", "b", "c"] as const) {
    if (skipCWorktree && id === "c") continue;
    const p = path.join(repo, ".worktrees", `issue-849-${id}`);
    await git(repo, ["worktree", "add", "-q", "--detach", p, baseSha]);
    wt[id] = p;
  }
  writeFileSync(path.join(wt.a, "a-file.txt"), "a\n");
  await git(wt.a, ["add", "a-file.txt"]);
  await git(wt.a, ["commit", "-q", "-m", "a"]);
  if (!skipCWorktree) {
    writeFileSync(path.join(wt.c, "c-file.txt"), "c\n");
    await git(wt.c, ["add", "c-file.txt"]);
    await git(wt.c, ["commit", "-q", "-m", "c"]);
  }
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
  // The stub: B's merge-and-retry commits its in-scope file (b-file.txt) AND
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
  // Exactly ONE merge-and-retry (the merge-and-retry; the second violation is
  // never re-developed). #1005 — the prompt is the merge prompt (the merged
  // workstream's id is the owner c; the violator b is absorbed into c).
  const recoveryCalls = calls.filter((c) => (c.prompt ?? "").includes("FENCE MERGE-AND-RETRY"));
  assert(
    recoveryCalls.length === 1 && recoveryCalls[0].cwd === wt.b,
    `#849 case 2 (merged as c): exactly ONE merge-and-retry, in the violator's worktree (got ${recoveryCalls.length})`,
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
  // The re-run's fence record is persisted. #1005 — the re-violation is
  // attributed to the MERGED workstream (the owner id, c) touching a-file.txt
  // (declared by a). The old record (b→c-file.txt, declared by c) is
  // superseded by the re-run's record.
  const reRunRecords = after.pipelineState.verifyEvidence?.fenceViolations ?? [];
  assert(
    reRunRecords.some(
      (r) => r.file === "a-file.txt" && r.kind === "sibling-declared" && r.declaredById === "a",
    ),
    `#849 case 2 (merged as c): the re-run's fence record names the merged workstream touching a-file.txt (declared by a) (got: ${JSON.stringify(reRunRecords)})`,
  );
}

// ── case 3: violator↔owner cycle (C dependsOn B; B violates C's file) —
// the dependent phase parks BEFORE the fence gate ──────────────────────────
//
// The #849 cycle check (fenceRecoveryCycles) was deleted with the #849
// recovery flow: under the #1005 merge-and-retry there is no "injected edge"
// to form a cycle with (a violator↔owner cycle is itself the merge), and the
// fence cap for this shape is unreachable through runDevelopTopological
// anyway — the driver's dependent phase (runDependentWorkstreams) parks
// FIRST: C's dependsOn makes the dependent phase resolve B's post-commit
// SHA and create C's deferred worktree, and that creation fails (C's
// commit is absent, or the existing tree is a dirty leftover), parking with
// the `deferred-creation:develop` cap BEFORE the develop fence gate ever
// runs. What this case asserts is therefore the INTEGRATION invariant:
// the driver parks with a terminal cap, with ZERO merge-and-retries and no
// fence-recovery-started event (nothing was merged or discarded).
{
  // Integration invariants: the driver parks (the dependent-phase park
  // preempts the fence gate in this shape) with ZERO merge-and-retries and no
  // fence-recovery-started event.
  const { repo, baseSha } = await fixture("cycle");
  const { wt } = await setup3WS(repo, baseSha, true);
  const calls: Call[] = [];
  const dispatchFn = recordingDispatch(calls);
  const ctx = ctxFor(repo, dispatchFn);
  const workstreams = ws3(["a-file.txt", "c-file.txt"], undefined, ["b"]);
  const base = initialState(849);
  base.pipelineState.baseSha = baseSha;
  base.pipelineState.worktrees = { a: wt.a, b: wt.b, c: wt.c };
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
    "job-849-cycle",
  );
  // #1005 — the fence gate records C's sibling-declared violation (B
  // annexed C's file; C's dependsOn on B is a SELF-fence demotion for C's
  // own tree, so the annexation is still a record), merges B into C,
  // merge-and-retries the merged workstream ONCE, and the re-run is clean (C's
  // missing tree is unassessable, so the re-run cannot record a
  // violation) — the flow PROCEEDS. The "cycle" the #849 flow would have
  // detected is, under #1005, precisely the merge: the cycle check is gone
  // because a violator↔owner cycle is the merge-and-retry itself.
  const caps = after.eventLog.filter(
    (e): e is Extract<import("../src/workflow-state.ts").WorkEvent, { kind: "cap-hit" }> =>
      e.kind === "cap-hit",
  );
  assert(
    caps.length === 0,
    `#849 case 3 (merged as c): the clean re-run proceeds — NO cap-hit (got: ${caps.map((c) => c.cap)})`,
  );
  const recoveryCalls = calls.filter((c) =>
    (c.prompt ?? "").includes("FENCE MERGE-AND-RETRY"),
  );
  assert(
    recoveryCalls.length === 1,
    `#849 case 3 (merged as c): exactly ONE merge-and-retry re-dispatch (the cycle IS the merge) (got ${recoveryCalls.length})`,
  );
  const rec = after.eventLog.find((e) => e.kind === "fence-recovery-started");
  assert(
    rec !== undefined &&
      rec.kind === "fence-recovery-started" &&
      rec.workstreamId === "c" &&
      rec.owners.includes("b"),
    `#849 case 3 (merged as c): the fence-recovery-started event records the merge c+b (got: ${rec ? JSON.stringify(rec) : "none"})`,
  );
  // The merged workstream's verdict is ok (the re-run was clean) and the
  // absorbed id b is re-keyed away from the converged verdicts.
  const conv = [...after.eventLog]
    .reverse()
    .find(
      (
        e,
      ): e is Extract<import("../src/workflow-state.ts").WorkEvent, { kind: "branches-converged" }> =>
        e.kind === "branches-converged" && e.step === "develop",
    );
  const cVerdict = conv?.verdicts.find((v) => v.id === "c");
  const bVerdict = conv?.verdicts.find((v) => v.id === "b");
  assert(
    cVerdict?.ok === true && bVerdict === undefined,
    `#849 case 3 (merged as c): the merged workstream c's verdict is ok and the absorbed id b is gone (got: ${JSON.stringify(conv?.verdicts)})`,
  );
}

// ── case 4: re-violation AND the re-run's verify gate passes — the park
// decision keys on the re-run's fence RECORDS, not gate2.ok ───────────────
//
// B's re-dispatch re-violates a-file.txt (declared by A, NOT in B's injected
// deps) and commits it. The re-run's fence gate records the fresh
// sibling-declared hit — its failure string reaches `failures`, but the
// fixture has no verify command to run, so a re-dispatch that PASSES the
// re-run's other gates while re-violating must still park (the lens finding:
// gate2.ok deriving from failures.length === 0 alone would let the
// re-violation ship through converge/commit-pr). The driver parks with the
// fence cap, the evidence names BOTH attempts, and B's verdict stays ok:false.
{
  const { repo, baseSha } = await fixture("reviolate-ok");
  const { wt, bSha } = await setup3WS(repo, baseSha);
  const calls: Call[] = [];
  // The stub: B's re-dispatch commits its in-scope file AND re-violates
  // a-file.txt (declared by A — NOT among B's injected deps).
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
    "job-849-reviolate-ok",
  );
  const caps = after.eventLog.filter(
    (e): e is Extract<import("../src/workflow-state.ts").WorkEvent, { kind: "cap-hit" }> =>
      e.kind === "cap-hit",
  );
  assert(
    caps.length === 1 && caps[0].cap === "fence-violation:develop",
    `#849 case 4: a re-violation that passes verify still parks with the fence cap (got: ${caps.map((c) => c.cap)})`,
  );
  const ev = caps[0]?.evidence ?? "";
  assert(
    ev.includes(bSha) && ev.includes("a-file.txt") && ev.includes("a"),
    `#849 case 4: the evidence names BOTH attempts (got: ${ev.slice(0, 200)})`,
  );
  // The merged workstream (c) is NOT restored to ok (the re-violation
  // stands). #1005 — the merged id is the owner c; the violator b is
  // absorbed into c, so the verdict is on c, not b.
  const conv = [...after.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "branches-converged" }> =>
        e.kind === "branches-converged" && e.step === "develop",
    );
  const cVerdict = conv?.verdicts.find((v) => v.id === "c");
  assert(
    cVerdict?.ok === false,
    `#849 case 4 (merged as c): the merged workstream c's final verdict is NOT ok (the re-violation stands) (got: ${JSON.stringify(conv?.verdicts)})`,
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
