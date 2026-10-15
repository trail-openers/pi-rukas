/**
 * exec — the one shell-or-argv executor the driver and forge code run through.
 *
 * `execp(cmd, { argv })` runs `cmd` as the executable with `argv` as its
 * arguments, through execFile: no shell re-parse. Without `argv`, `cmd` is a
 * shell string. Either way it resolves `{ stdout, stderr }` and rejects with
 * `promisify(exec)`'s error shape (`stdout` / `stderr` / `code` on the Error).
 *
 * Why one executor: a bare `promisify(exec)` type-checks as a driver `ExecFn`
 * that declares `argv`, and silently drops it — an argv-form call then runs a
 * bare `git`, which prints usage and exits 1 (#1279). Every seam that may
 * receive an argv form should default to `execp`. The only bare
 * `promisify(exec)` left is the documented shell-only seam in
 * work-driver-merged-mechanized.ts (typed `ShellExecFn`), and
 * test-exec-argv-contract.ts fails on any other.
 *
 * #1095 — `killGroup` runs the command in its own process group and, on
 * `timeout` or stdout overflow, SIGKILLs the whole group. Node's exec timeout
 * kills only the direct child, and an ssh grandchild that inherited stdout
 * keeps the pipe open, so the callback never fires and the orphan lives on.
 *
 * No driver imports: this module is a leaf, so any module may depend on it.
 * The driver's `VerifyExecFn` compatibility is checked in work-driver-git.ts.
 */

import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execShell = promisify(exec);
const execFileP = promisify(execFile);

export interface ExecOpts {
  /** argv form: `cmd` is the executable, `argv` its arguments. */
  argv?: string[];
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  /** Shell-string form only; the argv form has no shell and ignores it. */
  shell?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * #1095 — kill the whole process group on timeout or overflow. Set only by
   * the driver's network git calls (work-driver-net-git.ts).
   */
  killGroup?: boolean;
}

export type ExecResult = { stdout: string; stderr: string };

/** The shell-only executor shape: no `argv`, so an argv-form call on it is a compile error. */
export type ShellExecFn = (
  cmd: string,
  opts?: { cwd?: string; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr?: string }>;

/** #1095 — spawn detached, kill the process group on timeout or overflow. */
function execGroup(cmd: string, argv: string[] | undefined, opts: ExecOpts): Promise<ExecResult> {
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  return new Promise((resolve, reject) => {
    const common = {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    };
    const child = argv ? spawn(cmd, argv, common) : spawn(cmd, { ...common, shell: true });
    let stdout = "";
    let stderr = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A group kill carries the exec error shape: execFile's timeout error has
    // `killed` and `signal`, and every rejection carries the captured output.
    const groupKillError = (message: string) =>
      Object.assign(new Error(message), {
        killed: true,
        signal: "SIGKILL",
        code: null,
        stdout,
        stderr,
      });
    const killGroup = () => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // group already gone
      }
    };
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      settle();
    };
    if (opts.timeout !== undefined) {
      timer = setTimeout(() => {
        killGroup();
        finish(() => reject(groupKillError(`command timed out after ${opts.timeout}ms: ${cmd}`)));
      }, opts.timeout);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      if (stdout.length > maxBuffer) {
        killGroup();
        finish(() => reject(groupKillError(`stdout maxBuffer exceeded: ${cmd}`)));
      }
    });
    child.stderr.on("data", (d: string) => {
      // Bounded like stdout: a chatty ssh must not grow memory until the timeout.
      if (stderr.length < maxBuffer) stderr += d;
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code, signal) =>
      finish(() =>
        code === 0
          ? resolve({ stdout, stderr })
          : reject(
              Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), {
                code,
                signal: signal ?? null,
                killed: false,
                stdout,
                stderr,
              }),
            ),
      ),
    );
  });
}

/** The shared executor. The argv form never reaches a shell, so `opts.shell` is not forwarded to it. */
export function execp(cmd: string, opts: ExecOpts = {}): Promise<ExecResult> {
  if (opts.killGroup) return execGroup(cmd, opts.argv, opts);
  const { cwd, timeout, maxBuffer, env, shell } = opts;
  if (opts.argv) {
    return execFileP(cmd, opts.argv, { cwd, timeout, maxBuffer, env, encoding: "utf8" });
  }
  return execShell(cmd, { cwd, timeout, maxBuffer, env, shell, encoding: "utf8" });
}
