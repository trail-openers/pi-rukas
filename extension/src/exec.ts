/**
 * exec — the one shell-or-argv executor the driver and forge code run through.
 *
 * `execp(cmd, { argv })` runs `cmd` as the executable with `argv` as its
 * arguments through `spawn` with no shell (`stdio` fd 0 closed, so a CLI that
 * would prompt reads EOF instead of blocking). Without `argv`, `cmd` is a
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

import { exec, spawn } from "node:child_process";
import { promisify } from "node:util";

const execShell = promisify(exec);

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

/**
 * #2342 R3 — the argv form without a shell, with fd 0 closed.
 *
 * Deliberately `spawn` and not `promisify(execFile)`: `execFile` constructs its
 * own stdio and a caller's `stdio` option is dropped, so it cannot be handed
 * `"ignore"`. Everything else is kept the same on purpose — same
 * `cwd`/`env`/`timeout`/`maxBuffer`, the same `Command failed:`/overflow/timeout
 * rejection shape that `execFile` stamps (characterised against the real
 * `execFile`, so the swap is invisible to the callers that read `code`,
 * `killed`, `signal` and `message`), and the `encoding` honoured on both
 * streams so a `latin1` blob read still returns exact bytes.
 */
function execArgv(cmd: string, argv: string[], opts: ExecOpts): Promise<ExecResult> {
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  const encoding = opts.stdoutEncoding ?? "utf8";
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      settle();
    };
    if (opts.timeout !== undefined) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() =>
          reject(
            // execFile's own timeout error: `Command failed:` + the (empty)
            // stderr, `code` null, `killed` true, the terminating signal. No
            // `timedOutKill` — that field belongs to the group-kill paths, and
            // a caller reading it must not see a shape here that execFile never
            // stamped.
            Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), {
              code: null,
              killed: true,
              signal: "SIGTERM",
            }),
          ),
        );
      }, opts.timeout);
    }
    child.stdout?.setEncoding(encoding);
    child.stderr?.setEncoding(encoding);
    child.stdout?.on("data", (d: string) => {
      stdout += d;
      if (stdout.length > maxBuffer) {
        child.kill("SIGTERM");
        finish(() =>
          reject(
            Object.assign(new RangeError("stdout maxBuffer length exceeded"), {
              code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            }),
          ),
        );
      }
    });
    child.stderr?.on("data", (d: string) => {
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
    // #2342 R3 — the argv form goes through `spawn`, not `execFile`, so fd 0 can
    // be `ignore`. `execFile` builds its own stdio and a caller's `stdio` option
    // is dropped (verified on node and bun alike), so `promisify(execFile)` leaves
    // the child on a fresh PIPE: a CLI that decides to prompt — `glab mr create`
    // without its `-y`, anything that reads `GIT_TERMINAL_PROMPT` — sits on that
    // pipe reading, and this form carries no timeout unless the caller passes one.
    // `/dev/null` answers EOF at once, so a prompt fails instead of hanging the
    // driver, and it is the same answer the `killGroup` path above already gives
    // with its explicit `"ignore"`. `maxBuffer` is the shared default, as it is
    // for `execGroup`; `execFile`'s own 1 MiB default is the same figure.
    return execArgv(cmd, opts.argv, opts);
  }
  return execShell(cmd, { cwd, timeout, maxBuffer, env, shell, encoding });
}
