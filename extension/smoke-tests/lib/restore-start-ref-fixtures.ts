/** #1093 — shared fixtures for the restore-start-ref smoke tests (real git in temp repos). */
import { exec, execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WorkState } from "../../src/workflow-state.ts";
import type { ExecFn } from "../../src/worktree.ts";

export const result = { exit: 0 };
export function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    result.exit = 1;
  }
}

export const pExec = promisify(exec);
export const pExecFile = promisify(execFile);
/** Argv calls run via execFile (no shell), exactly as production's execp does. */
export const realExec: ExecFn = (cmd, opts) =>
  (opts?.argv
    ? pExecFile(cmd, opts.argv, { cwd: opts?.cwd, maxBuffer: opts?.maxBuffer })
    : pExec(cmd, { cwd: opts?.cwd, maxBuffer: opts?.maxBuffer })) as ReturnType<ExecFn>;
/** The command as a readable line, argv joined by spaces, for assertions. */
export const shown = (cmd: string, opts?: { argv?: string[] }) =>
  opts?.argv ? [cmd, ...opts.argv].join(" ") : cmd;

/** Temp repo: `main` with tracked.txt, a `feature/x` branch at the same commit,
 * and `feature/merged` checked out (the state a cycle leaves behind). */
export function buildRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "issue1093-start-ref-"));
  const g = (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.name", "t"]);
  g(["config", "user.email", "t@t"]);
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  g(["add", "-A"]);
  g(["commit", "-q", "-m", "base"]);
  g(["branch", "feature/x"]);
  g(["checkout", "-q", "-b", "feature/merged"]);
  return dir;
}

export const head = (dir: string) =>
  execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
export const sha = (dir: string, ref = "HEAD") =>
  execFileSync("git", ["rev-parse", ref], {
    cwd: dir,
    encoding: "utf8",
  }).trim();

export function stateWith(startRef: string | undefined, branchName: string): WorkState {
  return {
    schemaVersion: 1,
    resumable: false,
    issue: 1093,
    startedAt: 1,
    updatedAt: 2,
    pipelineState: {
      status: "running",
      currentStep: "merged",
      lastCompletedStep: "ci",
      reviewRound: 0,
      ciRetryCount: 0,
      inFlightJobIds: [],
      plumbReports: [],
      branchName,
      ...(startRef ? { startRef } : {}),
    },
    eventLog: [],
  };
}

