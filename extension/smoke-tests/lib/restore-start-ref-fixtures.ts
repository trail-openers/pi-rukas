/** #1093 — shared fixtures for the restore-start-ref smoke tests (real git in temp repos). */
import { exec, execFile, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { WorkState } from "../../src/workflow-state.ts";
import type { ExecFn } from "../../src/worktree.ts";
import { gitTestEnv } from "./git-test-env.ts";

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
/** Argv calls run via execFile (no shell), exactly as production's execp does.
 *
 * #1145 — `env: gitTestEnv()` on both branches. These are the executors the
 * driver-under-test is handed, so they are the door through which a fixture's
 * git reads reach the host: `execFile`/`exec` with no `env` option inherit the
 * REAL `environ` on bun 1.3, and a test that ran outside lib/verify-loop.sh
 * (a direct `bun run`, or a developer's single-file invocation) then resolved
 * the start-ref claim against the operator's `~/.config/git/ignore`. */
export const realExec: ExecFn = (cmd, opts) =>
  (opts?.argv
    ? pExecFile(cmd, opts.argv, {
        cwd: opts?.cwd,
        maxBuffer: opts?.maxBuffer,
        // #1404 — the caller's `env` is honoured when it passed one, on top of
        // the isolated git view. Without this, a driver that threads a variable
        // to the gate (the out-of-band `VERIFY_REPORT_FILE`) has it silently
        // dropped by the test's own executor, and every e2e assertion about the
        // report would be checking a channel that never existed.
        env: opts?.env ? { ...gitTestEnv(), ...opts.env } : gitTestEnv(),
      })
    : pExec(cmd, {
        cwd: opts?.cwd,
        maxBuffer: opts?.maxBuffer,
        env: opts?.env ? { ...gitTestEnv(), ...opts.env } : gitTestEnv(),
      })) as ReturnType<ExecFn>;
/** The command as a readable line, argv joined by spaces, for assertions. */
export const shown = (cmd: string, opts?: { argv?: string[] }) =>
  opts?.argv ? [cmd, ...opts.argv].join(" ") : cmd;

/** Temp repo: `main` with tracked.txt, a `feature/x` branch at the same commit,
 * and `feature/merged` checked out (the state a cycle leaves behind). */
export function buildRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "issue1093-start-ref-"));
  const g = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitTestEnv() });
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
    env: gitTestEnv(),
  }).trim();
export const sha = (dir: string, ref = "HEAD") =>
  execFileSync("git", ["rev-parse", ref], {
    cwd: dir,
    encoding: "utf8",
    env: gitTestEnv(),
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
