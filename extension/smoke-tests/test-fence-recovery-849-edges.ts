#!/usr/bin/env bun
/**
 * #849 — two fence-recovery paths the round-3 report claimed case 5 covered
 * but did not (case 5's stub fails only `git reset --hard`):
 *
 * Case 1 (owner rev-parse failure) — the recovery's discard reads the
 * OWNER's tip with `git rev-parse HEAD` in the owner's worktree BEFORE any
 * reset. The exec stub rejects that read ONLY when the cwd is the owner's
 * worktree, so the violator's own HEAD read (a different worktree) still
 * succeeds: the failure is the owner-side precondition, not the reset. The
 * driver must park with the `fence-violation:develop` cap naming the
 * violator AND the owner, with ZERO re-dispatches, NO fence-recovery-started
 * event (nothing was discarded), and the violator's worktree HEAD unchanged
 * (no reset ran).
 *
 * Case 2 (non-fence verify failure after a clean re-run) — the violator's
 * re-dispatch does NOT re-violate (the re-run's fence gate records no
 * blocking record), but the re-run's verify command fails (the exec ref is
 * swapped in-process from the real executor to a stub that fails a command
 * string the re-run will execute). The park is the `verify-failed:develop`
 * cap (NOT the fence cap): the re-run passed the fence and the failure is a
 * genuine verify failure. The fence-recovery-started event exists (the
 * discard completed — this is the path case 5 does not exercise), exactly
 * ONE re-dispatch happened, and the violator's verdict stays ok:false (the
 * honest-restore rule: a recovered violator returns to ok:true ONLY when the
 * re-run gate passed — it did not).
 */

import { exec as cpExec, execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { type WorkEvent, initialState } from "../src/workflow-state.ts";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);
const execp = promisify(cpExec);

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

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-849edge-"));

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

/** A recording dispatch. `onRecovery` fires only for the fence merge-and-retry
 * prompt (the merge-and-retry), with the worktree's cwd. */
function recordingDispatch(
  calls: Call[],
  onRecovery?: (cwd: string) => Promise<void>,
): NonNullable<DriverContext["dispatchFn"]> {
  const fn = async (
    _pi: unknown,
    spec: { role: string; cwd?: string; prompt?: string },
  ): Promise<DispatchResult> => {
    calls.push({ role: spec.role, cwd: spec.cwd, prompt: spec.prompt });
    if ((spec.prompt ?? "").includes("FENCE MERGE-AND-RETRY") && onRecovery && spec.cwd) {
      await onRecovery(spec.cwd);
    }
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

/** Build the driver context for the fence-recovery flow. The test can swap
 * `ctx.verifyExecFn` in-process between gate 1 and gate 2 (case 2). */
function ctxFor(repo: string, dispatchFn: NonNullable<DriverContext["dispatchFn"]>): DriverContext {
  const fixture: Pick<
    DriverContext,
    "repoRoot" | "issue" | "issues" | "stateRef" | "dispatchFn"
  > & {
    // biome-ignore lint/suspicious/noExplicitAny: driver fixture — the pi binding is never touched on this path
    pi: any;
    verifyExecFn: ExecFn;
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

/** Three worktrees from base; A + C commit their own file, B commits C's
 * declared file (the first fence violation — the fixture shape from case 1
 * of test-fence-recovery-849.ts). */
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
  writeFileSync(path.join(wt.b, "c-file.txt"), "B annexed c's file\n");
  await git(wt.b, ["add", "c-file.txt"]);
  await git(wt.b, ["commit", "-q", "-m", "b-violation"]);
  return {
    wt,
    bSha: await gitOut(wt.b, ["rev-parse", "HEAD"]),
    cSha: await gitOut(wt.c, ["rev-parse", "HEAD"]),
  };
}

const workstreams3 = {
  a: { id: "a", scope: "a", paths: ["a-file.txt"], outOfScope: ["b-file.txt", "c-file.txt"] },
  b: { id: "b", scope: "b", paths: ["b-file.txt"], outOfScope: ["a-file.txt", "c-file.txt"] },
  c: { id: "c", scope: "c", paths: ["c-file.txt"], outOfScope: ["a-file.txt", "b-file.txt"] },
};

function capsOf(events: WorkEvent[]): Array<Extract<WorkEvent, { kind: "cap-hit" }>> {
  return events.filter((e): e is Extract<WorkEvent, { kind: "cap-hit" }> => e.kind === "cap-hit");
}

// ── case 1: owner rev-parse failure — park with the fence cap, ZERO
// merge-and-retries, evidence names the violator AND the owner, no
// fence-recovery-started event, the violator's HEAD unchanged ───────────
{
  const { repo, baseSha } = await fixture("ownerrev");
  const { wt, bSha, cSha } = await setup3WS(repo, baseSha);

  const ownerWt = wt.c;
  // The stub: reject `git rev-parse HEAD` ONLY in the owner's worktree.
  // The violator's own HEAD read (a different worktree) still succeeds, so
  // this is specifically the OWNER-side precondition failing (case 5's
  // stub failed the reset itself — a different precondition).
  const stubExec: ExecFn = async (cmd, o) => {
    if (cmd === "git rev-parse HEAD" && o?.cwd === ownerWt) {
      const err = new Error("Command failed: git rev-parse HEAD") as Error & {
        stderr: string;
      };
      err.stderr = "fatal: cannot resolve HEAD";
      throw err;
    }
    return realExec(cmd, o);
  };

  const calls: Call[] = [];
  const dispatchFn = recordingDispatch(calls);
  const ctx = ctxFor(repo, dispatchFn);
  const base = initialState(849);
  base.pipelineState.baseSha = baseSha;
  base.pipelineState.worktrees = wt;
  base.pipelineState.workstreamBaseShas = { a: baseSha, b: baseSha, c: baseSha };
  base.pipelineState.workstreams = workstreams3;
  base.pipelineState.currentStep = "develop";
  const after = await runDevelopTopological(
    ctx,
    base,
    ["a", "b", "c"],
    workstreams3,
    [849],
    dispatchFn,
    stubExec,
    Date.now(),
    "job-849-ownerrev",
  );
  const caps = capsOf(after.eventLog);
  assert(
    caps.length === 1 && caps[0].cap === "fence-violation:develop",
    `#849 edge case 1: an owner rev-parse failure parks with the fence cap (got: ${caps.map((c) => c.cap)})`,
  );
  const ev = caps[0]?.evidence ?? "";
  // #1005 — the evidence names the MERGED workstream (the owner c) and the
  // absorbed violator (b): the merge-and-retry was attempted for the pair
  // c+b before the owner's SHA read failed. The park message names the
  // owner (c) and the worktree; the violator (b) is named in the merge
  // shape (the pair is c+b).
  assert(
    ev.includes("owner c") && ev.includes("rev-parse"),
    `#849 edge case 1 (merged as c): the evidence names the owner (c) and the failing rev-parse (got: ${ev.slice(0, 300)})`,
  );
  const recoveryCalls = calls.filter((c) => (c.prompt ?? "").includes("FENCE MERGE-AND-RETRY"));
  assert(
    recoveryCalls.length === 0,
    `#849 edge case 1: ZERO merge-and-retries when the owner's SHA cannot be read (got ${recoveryCalls.length})`,
  );
  const rec = after.eventLog.find((e) => e.kind === "fence-recovery-started");
  assert(
    rec === undefined,
    `#849 edge case 1: no fence-recovery-started event (nothing was discarded) (got: ${rec ? rec.kind : "none"})`,
  );
  // The discard never ran: the violator's worktree HEAD is still the
  // violation commit (bSha), unchanged.
  const bHead = await gitOut(wt.b, ["rev-parse", "HEAD"]);
  assert(
    bHead === bSha,
    `#849 edge case 1: the violator's worktree HEAD is unchanged (no reset happened) (got ${bHead.slice(0, 8)}, expected ${bSha.slice(0, 8)})`,
  );
  // The owner's commit is intact too (the stub is the only failure).
  const cHead = await gitOut(wt.c, ["rev-parse", "HEAD"]);
  assert(
    cHead === cSha,
    `#849 edge case 1: the owner's worktree is untouched (got ${cHead.slice(0, 8)}, expected ${cSha.slice(0, 8)})`,
  );
}

// ── case 2: clean re-run + failing verify — the fence cap (the #1005
// merge-and-retry's second-failure handoff; the verify failure is the second
// failure, so the handoff names the merge). The fence-recovery-started event
// exists, exactly one merge-and-retry (the merge prompt, in the violator's
// worktree), and the merged workstream's verdict stays ok:false ─────────
{
  const { repo, baseSha } = await fixture("verifyfail");
  const { wt, bSha } = await setup3WS(repo, baseSha);

  // The stub: the re-run's verify command (`verify-cmd`) fails. The stub is
  // stateful on a `gate2` flag: it passes `verify-cmd` through while gate 1
  // (the first develop verify) runs — the fixture has no .pi/verify-cmd yet,
  // so gate 1 discovers no verify command and its sole failure is the fence,
  // which recovers. After the merge-and-retry (onRecovery sets `gate2`), the
  // stub fails `verify-cmd` so gate 2 (the re-run) reports a verify failure.
  const gate2 = { value: false };
  const stubExec: ExecFn = async (cmd, o) => {
    if (cmd === "verify-cmd" && gate2.value) {
      const err = new Error("Command failed: verify-cmd") as Error & { stderr: string };
      err.stderr = "FAIL: 1 assertion failed (expected green, got red)";
      throw err;
    }
    return realExec(cmd, o);
  };
  const calls: Call[] = [];
  const onRecovery = async (cwd: string) => {
    writeFileSync(path.join(cwd, "b-file.txt"), "b\n");
    await git(cwd, ["add", "b-file.txt"]);
    await git(cwd, ["commit", "-q", "-m", "b-clean"]);
    // Write .pi/verify-cmd to the worktrees AND the repo root so gate 2
    // (the re-run) discovers the verify command. The per-worktree verify
    // runs with cwd=worktree; the consolidated verify runs with
    // cwd=repoRoot. The stub fails `verify-cmd` in both.
    for (const w of [wt.a, wt.b, wt.c, repo]) {
      mkdirSync(path.join(w, ".pi"), { recursive: true });
      writeFileSync(path.join(w, ".pi", "verify-cmd"), "verify-cmd\n");
    }
    // Flip the stub's flag: gate 2 (the re-run) now fails `verify-cmd`.
    gate2.value = true;
  };
  const dispatchFn = recordingDispatch(calls, onRecovery);
  const ctx = ctxFor(repo, dispatchFn);
  // Install the stub: gate 1 (the first develop verify) discovers no verify
  // command (the fixture has no .pi/verify-cmd yet) and fails only on the
  // fence (which recovers). Gate 2 (the re-run) discovers the verify
  // command (the merge-and-retry's onCall wrote .pi/verify-cmd) and the stub's
  // `verify-cmd` failure is the re-run's verify failure.
  (ctx as unknown as { verifyExecFn: ExecFn }).verifyExecFn = stubExec;
  const base = initialState(849);
  base.pipelineState.baseSha = baseSha;
  base.pipelineState.worktrees = wt;
  base.pipelineState.workstreamBaseShas = { a: baseSha, b: baseSha, c: baseSha };
  base.pipelineState.workstreams = workstreams3;
  base.pipelineState.currentStep = "develop";
  const after = await runDevelopTopological(
    ctx,
    base,
    ["a", "b", "c"],
    workstreams3,
    [849],
    dispatchFn,
    execp as unknown as ExecFn,
    Date.now(),
    "job-849-verifyfail",
  );
  const caps = capsOf(after.eventLog);
  // #1005 — a second failure (verify) after the merge hands off with the
  // fence cap (the #1005 acceptance criterion: a second failure after
  // merging hands off, and the handoff names the merge).
  assert(
    caps.length === 1 && caps[0].cap === "fence-violation:develop",
    `#849 edge case 2 (merged as c): a clean re-run with a failing verify hands off with the FENCE cap (the merge is named in the evidence) (got: ${caps.map((c) => c.cap)})`,
  );
  // The re-run's fence gate: the merged workstream (c) is the workstream the
  // merge-and-retry ran in. The merge-and-retry committed only b-file.txt (in-scope
  // for the merged workstream), so the re-run's fence gate is clean for c
  // (no blocking record names c). The first attempt's record (b→c-file.txt)
  // is the stashed verifyEvidence, not the re-run's.
  const reRunFenceRecords = (after.pipelineState.verifyEvidence?.fenceViolations ?? []).filter(
    (r) => r.workstreamId === "c" && r.kind !== "undeclared",
  );
  assert(
    reRunFenceRecords.length === 0,
    `#849 edge case 2 (merged as c): the re-run's fence gate recorded no blocking violation for the merged workstream (the merge-and-retry was clean) (got: ${JSON.stringify(after.pipelineState.verifyEvidence?.fenceViolations)})`,
  );
  // The discard completed: the fence-recovery-started event exists (this is
  // the path case 5 does not exercise — its stub failed the reset itself).
  // #1005 — the event names the MERGED workstream (the owner c) as the
  // workstreamId and the absorbed violator (b) in owners.
  const rec = after.eventLog.find((e) => e.kind === "fence-recovery-started");
  assert(
    rec !== undefined &&
      rec.kind === "fence-recovery-started" &&
      rec.workstreamId === "c" &&
      rec.owners.includes("b") &&
      /^[0-9a-f]{40}$/.test(rec.discardedSha ?? ""),
    `#849 edge case 2 (merged as c): a fence-recovery-started event exists, naming the merged workstream c and the absorbed violator b (got: ${rec ? JSON.stringify(rec) : "none"})`,
  );
  // Exactly one merge-and-retry (the merge-and-retry; the verify failure is never
  // re-developed). #1005 — the prompt is the merge prompt.
  const recoveryCalls = calls.filter((c) => (c.prompt ?? "").includes("FENCE MERGE-AND-RETRY"));
  assert(
    recoveryCalls.length === 1 && recoveryCalls[0].cwd === wt.b,
    `#849 edge case 2 (merged as c): exactly ONE merge-and-retry, in the violator's worktree (the recovery) (got ${recoveryCalls.length})`,
  );
  // The honest-restore rule: the merged workstream returns to ok:true ONLY
  // when the re-run gate passed. The re-run gate did NOT pass (the verify
  // failed), so c's verdict stays ok:false.
  const conv = [...after.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "branches-converged" }> =>
        e.kind === "branches-converged" && e.step === "develop",
    );
  const cVerdict = conv?.verdicts.find((v) => v.id === "c");
  assert(
    cVerdict?.ok === false,
    `#849 edge case 2 (merged as c): the merged workstream c's final verdict stays ok:false (the re-run gate failed) (got: ${JSON.stringify(conv?.verdicts)})`,
  );
  // The discarded commit is no longer the violator's HEAD (the reset ran);
  // the merge-and-retry's clean commit sits on top of the owner's tip.
  const bHead = await gitOut(wt.b, ["rev-parse", "HEAD"]);
  // #1005 — the merged workstream's base is the owner's tip (workstreamBaseShas
  // is keyed by the merged id, the owner c — the violator b's entry was
  // removed by the merge).
  const rebased = after.pipelineState.workstreamBaseShas?.c ?? "";
  assert(
    bHead !== bSha,
    `#849 edge case 2 (merged as c): b's worktree HEAD moved from the discarded SHA (the reset ran) (got ${bHead.slice(0, 8)}, discarded ${bSha.slice(0, 8)})`,
  );
  assert(
    /^[0-9a-f]{40}$/.test(rebased),
    `#849 edge case 2 (merged as c): the merged workstream was re-based onto the owner's tip (workstreamBaseShas[c] is a 40-char SHA) (got: ${rebased})`,
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
