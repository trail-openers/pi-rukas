#!/usr/bin/env bun
/**
 * #849 — fence recovery: a git failure discarding the violator's commit.
 *
 * The driver's discard (`git reset --hard <ownerSha>` in the violator's
 * worktree) fails (the exec stub rejects the reset). The lens finding: the
 * pre-fix code caught the error and `continue`d — no event, no evidence, no
 * trace — and re-dispatched the violator anyway, re-running it on top of its
 * own violating commit (a re-violation by construction) with a partial
 * recovery indistinguishable from success. Post-fix: if ANY violator cannot
 * be discarded, do NOT re-dispatch anyone — park immediately with the
 * `fence-violation:develop` cap, naming the violator, the failing command and
 * the git error.
 *
 * Driven through the REAL runDevelopTopological in a live temp git repo with
 * an exec stub that rejects `git reset --hard` (everything else delegates to
 * the real git). Cases:
 *   - the park: the fence cap with evidence naming the violator, the
 *     `git reset --hard` command and the git error detail.
 *   - ZERO re-dispatches (the recovery re-dispatch never fires).
 *   - no fence-recovery-started event (the discard did not complete).
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { DispatchResult } from "../src/types.ts";
import { runDevelopTopological } from "../src/work-develop-topological.ts";
import type { DriverContext } from "../src/work-driver-context.ts";
import { initialState, type WorkState } from "../src/workflow-state.ts";
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

const root = mkdtempSync(path.join(tmpdir(), "pi-ens-849git-"));

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

/** A recording dispatch. */
function recordingDispatch(calls: Call[]): NonNullable<DriverContext["dispatchFn"]> {
  const fn = async (
    _pi: unknown,
    spec: { role: string; cwd?: string; prompt?: string },
  ): Promise<DispatchResult> => {
    calls.push({ role: spec.role, cwd: spec.cwd, prompt: spec.prompt });
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

/** An exec stub that rejects the discard: `git reset --hard` fails with a
 * simulated git error (the error carries `stderr` the way `promisify(exec)`
 * does, so `gitErrorDetail` reads the real git output); everything else
 * delegates to the real git. */
function failingResetExec(): ExecFn {
  return async (cmd, o) => {
    if (cmd.includes("git reset --hard")) {
      const err = new Error("Command failed: git reset --hard \"<sha>\"") as Error & {
        stderr: string;
      };
      err.stderr = "fatal: unable to write new index";
      throw err;
    }
    return realExec(cmd, o);
  };
}

function ctxFor(
  repo: string,
  dispatchFn: NonNullable<DriverContext["dispatchFn"]>,
  verifyExecFn: ExecFn,
): DriverContext {
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
    verifyExecFn,
    stateRef: { current: initialState(849) },
    dispatchFn,
  };
  return fixture as unknown as DriverContext;
}

// ── case 5: a git failure discarding the violator's commit — park with the
// fence cap, ZERO re-dispatches, evidence naming the violator + command +
// git error ───────────────────────────────────────────────────────────────
{
  const { repo, baseSha } = await fixture("gitfail");
  // Three worktrees from base; A + C commit their own file, B commits C's
  // declared file (the first violation — the fixture shape from case 1).
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

  const calls: Call[] = [];
  const dispatchFn = recordingDispatch(calls);
  const verifyExec = failingResetExec();
  const ctx = ctxFor(repo, dispatchFn, verifyExec);
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
  const after: WorkState = await runDevelopTopological(
    ctx,
    base,
    ["a", "b", "c"],
    workstreams,
    [849],
    dispatchFn,
    verifyExec,
    Date.now(),
    "job-849-gitfail",
  );
  const caps = after.eventLog.filter(
    (e): e is Extract<import("../src/workflow-state.ts").WorkEvent, { kind: "cap-hit" }> =>
      e.kind === "cap-hit",
  );
  assert(
    caps.length === 1 && caps[0].cap === "fence-violation:develop",
    `#849 case 5: a git failure discarding the violator parks with the fence cap (got: ${caps.map((c) => c.cap)})`,
  );
  const ev = caps[0]?.evidence ?? "";
  assert(
    ev.includes("b") && ev.includes("git reset --hard") && ev.includes("fatal:"),
    `#849 case 5: the evidence names the violator, the failing command and the git error (got: ${ev.slice(0, 300)})`,
  );
  // ZERO re-dispatches (the recovery re-dispatch never fires when the
  // discard fails).
  const recoveryCalls = calls.filter((c) =>
    (c.prompt ?? "").includes("FENCE RECOVERY RE-DISPATCH"),
  );
  assert(
    recoveryCalls.length === 0,
    `#849 case 5: ZERO re-dispatches when the discard fails (got ${recoveryCalls.length})`,
  );
  // No fence-recovery-started event (the discard did not complete).
  const rec = after.eventLog.find((e) => e.kind === "fence-recovery-started");
  assert(
    rec === undefined,
    `#849 case 5: no fence-recovery-started event when the discard fails (got: ${rec ? rec.kind : "none"})`,
  );
}

rmSync(root, { recursive: true, force: true });
console.log(`\nexit ${exit}`);
process.exit(exit);
