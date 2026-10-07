#!/usr/bin/env bun
/**
 * #849 — the develop step's fence recovery. Three workstreams where B edits
 * a file C declared: a `fence-recovery-started` event is recorded, ONLY B is
 * re-dispatched, B's worktree HEAD contains C's commit, and after a clean
 * re-run the flow proceeds (no cap-hit). A second violation parks with the
 * `fence-violation:develop` cap (evidence names BOTH attempts). A
 * violator↔owner cycle parks with zero re-dispatches.
 *
 * Driven through the REAL runDevelopTopological in a live temp git repo
 * (the #814-persisted test's shape), with a recording dispatch that commits
 * the violated file on call 1 (the violation) and the in-scope file on call
 * 2 (the clean re-run) — the stub simulates the developer's work in the
 * worktree the driver reset.
 *
 * Cases 2 and 3 (the second-violation park and the violator↔owner-cycle
 * park) live in test-fence-recovery-849-park.ts (the 500-line gate).
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

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-849-"));

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

/** A recording dispatch: records (role, cwd) per call. `onCall` simulates
 * the developer's work in the worktree (the stub commits the right file on
 * each call). */
function recordingDispatch(
  calls: Array<{ role: string; cwd?: string; prompt?: string }>,
  onCall?: (n: number, cwd: string) => Promise<void>,
): NonNullable<DriverContext["dispatchFn"]> {
  let n = 0;
  const fn = async (
    _pi: unknown,
    spec: { role: string; cwd?: string; prompt?: string },
  ): Promise<DispatchResult> => {
    n += 1;
    calls.push({ role: spec.role, cwd: spec.cwd, prompt: spec.prompt });
    if (onCall && spec.cwd) await onCall(n, spec.cwd);
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

// ── helper: create three worktrees from base, A + C commit their own file,
// B commits C's declared file (the fence violation) ──────────────────────
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

// ── case 1: clean re-run — recovery proceeds (no cap-hit) ──────────────
{
  const { repo, baseSha } = await fixture("clean");
  const { wt, bSha, cSha } = await setup3WS(repo, baseSha);
  const calls: Array<{ role: string; cwd?: string; prompt?: string }> = [];
  // The stub: call 1 = the fan-out (B already violated in the fixture);
  // calls after recovery = B's re-dispatch — commit B's own file (clean).
  const onCall = async (_n: number, cwd: string) => {
    if (cwd === wt.b) {
      writeFileSync(path.join(cwd, "b-file.txt"), "b\n");
      await git(cwd, ["add", "b-file.txt"]);
      await git(cwd, ["commit", "-q", "-m", "b-recovered"]);
    }
  };
  const dispatchFn = recordingDispatch(calls, onCall);
  const ctx = ctxFor(repo, dispatchFn);
  const workstreams = {
    a: { id: "a", scope: "a", paths: ["a-file.txt"], outOfScope: ["b-file.txt", "c-file.txt"] },
    b: { id: "b", scope: "b", paths: ["b-file.txt"], outOfScope: ["a-file.txt", "c-file.txt"] },
    c: { id: "c", scope: "c", paths: ["c-file.txt"], outOfScope: ["a-file.txt", "b-file.txt"] },
  };
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
    "job-849-clean",
  );
  // A fence-recovery-started event is recorded. The merged workstream's id is
  // the OWNER's id (c; the violator b is absorbed into c), so the event names
  // c as the merged workstream and b as the absorbed owner.
  const rec = after.eventLog.find((e) => e.kind === "fence-recovery-started");
  assert(
    rec !== undefined &&
      rec.kind === "fence-recovery-started" &&
      rec.workstreamId === "c" &&
      rec.owners.includes("b"),
    `#849 case 1 (merged as c): a fence-recovery-started event is recorded for the merged workstream c, naming the absorbed violator b (got: ${JSON.stringify(rec)})`,
  );
  // The discarded SHA is recorded (a 40-char hex SHA; it is the violator's
  // HEAD at recovery time — the fixture may have committed between the
  // `bSha` read and the run, so assert the shape, not the exact value).
  assert(
    rec !== undefined &&
      rec.kind === "fence-recovery-started" &&
      typeof rec.discardedSha === "string" &&
      /^[0-9a-f]{40}$/.test(rec.discardedSha),
    `#849 case 1: the discarded SHA is recorded (got: ${rec && rec.kind === "fence-recovery-started" ? rec.discardedSha : "n/a"})`,
  );
  // #1005 — the merged workstream's id is the OWNER's id (c; the violator b
  // is absorbed into c). The re-dispatch prompt names the merged id (c), and
  // the re-dispatch runs in the violator's worktree (wt.b), which was rebased
  // to c's tip. Exactly ONE re-dispatch (the merge-and-retry; the fan-out's
  // a/b/c dispatches carry the developer prompt, not the merge prompt).
  const recoveryCalls = calls.filter((c) => (c.prompt ?? "").includes("FENCE MERGE-AND-RETRY"));
  assert(
    recoveryCalls.length === 1 && recoveryCalls[0].cwd === wt.b,
    `#849 case 1 (merged as c): ONLY the merged workstream is re-dispatched, in the violator's worktree (got ${recoveryCalls.length} recovery call(s))`,
  );
  // B's worktree HEAD contains C's commit (reset to the owner's tip, then the
  // recovery commit on top). `merge-base --is-ancestor cSha bHead` exits 0
  // when cSha is an ancestor of bHead (the recovery's reset put c's tip in
  // b's history).
  const bHead = await gitOut(wt.b, ["rev-parse", "HEAD"]);
  const cIsAncestor = await git(wt.b, ["merge-base", "--is-ancestor", cSha, bHead])
    .then(() => true)
    .catch(() => false);
  assert(
    cIsAncestor,
    `#849 case 1: b's worktree HEAD contains c's commit (cSha ${cSha.slice(0, 8)} is an ancestor of bHead ${bHead.slice(0, 8)})`,
  );
  // After the clean re-run the flow proceeds: NO cap-hit (the fence re-run
  // passed — b's re-violation was committed on top of c's file, but b's
  // fence carve-out now exempts c's declared file via the injected
  // dependsOn edge, so the re-run is clean).
  const capHit = after.eventLog.find((e) => e.kind === "cap-hit");
  assert(
    capHit === undefined,
    `#849 case 1: the clean re-run proceeds — NO cap-hit (got: ${capHit ? capHit.kind : "none"})`,
  );
  // #1005 — the recovered verdict: the SURVIVING merged workstream's id is
  // the owner's (c); the absorbed violator (b) is re-keyed away — its id is
  // no longer a workstream, so the converged verdicts carry no entry for b
  // and a single entry for c. The clean re-run restores c to ok:true.
  const conv = [...after.eventLog]
    .reverse()
    .find(
      (
        e,
      ): e is Extract<
        import("../src/workflow-state.ts").WorkEvent,
        { kind: "branches-converged" }
      > => e.kind === "branches-converged" && e.step === "develop",
    );
  const cVerdict = conv?.verdicts.find((v) => v.id === "c");
  const bVerdict = conv?.verdicts.find((v) => v.id === "b");
  assert(
    cVerdict?.ok === true && bVerdict === undefined,
    `#849 case 1: the merged workstream c's verdict is ok (the re-run passed) and the absorbed id b is no longer a workstream (got: ${JSON.stringify(conv?.verdicts)})`,
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
