/**
 * exec — the one shell-or-argv executor the driver and forge code run through.
 *
 * `execp(cmd, { argv })` runs `cmd` as the executable with `argv` as its
 * arguments through `execFile`: no shell re-parse, and the child's stdin is
 * ended at once, so a CLI that would prompt reads EOF instead of blocking.
 * Without `argv`, `cmd` is a shell string. Either way it resolves
 * `{ stdout, stderr }` and rejects with `promisify(exec)`'s error shape
 * (`stdout` / `stderr` / `code` on the Error).
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
  /**
   * How stdout is decoded. The default `utf8` is for text. `latin1` maps every
   * byte to one character, so `Buffer.from(stdout, "latin1")` returns the
   * command's exact bytes — `utf8` would replace an invalid sequence with
   * U+FFFD and the bytes could not be recovered. Blob reads use `latin1`.
   */
  stdoutEncoding?: "utf8" | "latin1";
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
    //
    // #1414 round 3 — the two kill paths are distinguished the way
    // `exec-tree.ts` distinguishes them: `killed` says the group was
    // signalled, `timedOutKill` says the WALL CLOCK is what signalled it, and
    // `overflow` names the stream that broke its bound. Stamping `killed`
    // alone on the overflow path let every consumer read a chatty run as a
    // hung one — the checkpoint's typecheck classifier is such a consumer
    // (finding 3), and `isTimedOutKill` is the shared reader.
    const groupKillError = (message: string, streamOverflowed?: string) =>
      Object.assign(new Error(message), {
        killed: true,
        timedOutKill: streamOverflowed === undefined,
        ...(streamOverflowed === undefined ? {} : { overflow: streamOverflowed }),
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
        finish(() =>
          reject(groupKillError(`command timed out after ${opts.timeout}ms: ${cmd}`, undefined)),
        );
      }, opts.timeout);
    }
    child.stdout.setEncoding(opts.stdoutEncoding ?? "utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      if (stdout.length > maxBuffer) {
        killGroup();
        finish(() => reject(groupKillError(`stdout maxBuffer exceeded: ${cmd}`, "stdout")));
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
  const encoding = opts.stdoutEncoding ?? "utf8";
  if (opts.argv) {
    // #2342 — end the child's stdin. `execFile` builds its own stdio (a caller's
    // `stdio` option is dropped, verified on node and bun alike), so the child
    // starts on a fresh PIPE for fd 0 and a CLI that decides to prompt — `glab
    // mr create` without its `-y`, anything that consults `GIT_TERMINAL_PROMPT`
    // — sits reading that pipe, with no timeout to end it unless the caller
    // passes one. Closing the writable half gives the child EOF at once, so a
    // prompt fails instead of hanging the driver. `promisify(execFile)` exposes
    // the ChildProcess as `.child`, which is what makes this one line; the
    // rejection keeps execFile's own captured `stdout`/`stderr` on the Error,
    // which `gitCatFileSaysAbsent` classifies a git probe out of.
    const run = execFileP(cmd, opts.argv, { cwd, timeout, maxBuffer, env, encoding });
    run.child.stdin?.end();
    return run;
  }
  return execShell(cmd, { cwd, timeout, maxBuffer, env, shell, encoding });
}
