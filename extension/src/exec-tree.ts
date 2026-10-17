/**
 * exec-tree — a shell executor whose timeout reaches the whole process tree.
 *
 * `child_process.exec`'s `timeout` signals the SHELL and nothing else. The
 * driver's verify / smoke commands are project gates — a shell that starts a
 * test runner that starts hundreds of children — so a gate killed at its
 * timeout left every descendant running, holding pids and the worktree for
 * the rest of the cycle (measured: `exec("bash -c 'sleep 4 & wait'",
 * {timeout: 500})` rejects at 508 ms with the `sleep` still alive, on node
 * and on bun alike). In a pid-limited container that is how a timed-out gate
 * turns into `fork: Resource temporarily unavailable` for every later step.
 *
 * `execTree` runs the command as the leader of its own process group
 * (`detached`) and signals the GROUP: SIGTERM at the timeout, so git and
 * test runners can drop their lockfiles, then SIGKILL after a grace for
 * whatever ignored it. Node still reaps the leader; the descendants are
 * reaped by whatever init the host has.
 *
 * It resolves and rejects in `promisify(exec)`'s shape — `{stdout, stderr}`,
 * and an Error carrying `code` / `killed` / `signal` / `cmd` / `stdout` /
 * `stderr` — because every caller's failure reporting reads those fields.
 *
 * Out of reach by construction: a descendant that left the group (`setsid`,
 * GNU `timeout` without `--foreground`). The promise still settles — it does
 * not wait on a pipe such a process holds open.
 */

import { type ChildProcess, spawn } from "node:child_process";

/** SIGTERM → SIGKILL grace, matching the child-Pi kill in spawn-caps.ts. */
const KILL_GRACE_MS = 5_000;

export interface ExecTreeOpts {
  cwd?: string;
  timeout?: number;
  /** Per-stream cap in characters; `exec`'s default. */
  maxBuffer?: number;
  shell?: string;
  /** The child's environment; the parent's when absent (as `exec`). */
  env?: NodeJS.ProcessEnv;
  /**
   * argv form: `cmd` is the executable and `argv` its arguments, run with no
   * shell. The driver's `ExecFn` type declares it, so an executor standing
   * in for one must honour it: a dropped `argv` runs a bare `git`, which
   * prints usage and exits 1 with an empty stderr (`Command failed: git`).
   */
  argv?: string[];
  /** Tests shorten the SIGTERM → SIGKILL grace; production omits it. */
  killGraceMs?: number;
}

export type ExecTreeError = Error & {
  code?: number | string | null;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
  cmd?: string;
  stdout?: string;
  stderr?: string;
  /**
   * #1427 — the pid of the process whose GROUP was killed: the leader this
   * executor spawned (`detached`), whose pid is also its pgid. A caller that
   * reports a hang walks the tree under this pid; a caller that killed
   * something else entirely has no business naming processes.
   *
   * Set on the timeout/maxBuffer kill paths only — a non-zero exit is not a
   * kill, and `treePid` on one would invite a snapshot of processes the gate
   * never started.
   */
  treePid?: number;
};

/** Signal the child's whole process group; fall back to the child alone. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // No such group (already gone), or a platform without process groups.
    child.kill(signal);
  }
}

export function execTree(
  cmd: string,
  opts: ExecTreeOpts = {},
): Promise<{ stdout: string; stderr: string }> {
  const maxBuffer = opts.maxBuffer ?? 1024 * 1024;
  const argv = opts.argv;
  // What a failure names: the whole command, in either form.
  const shown = argv ? [cmd, ...argv].join(" ") : cmd;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv ?? [], {
      cwd: opts.cwd,
      env: opts.env,
      shell: argv ? false : (opts.shell ?? true),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let overflow: string | undefined;
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const settle = (spawnError?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const code = exited?.code ?? null;
      if (!spawnError && !killed && !overflow && code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const err: ExecTreeError =
        spawnError ??
        (overflow
          ? new RangeError(`${overflow} maxBuffer length exceeded`)
          : new Error(`Command failed: ${shown}\n${stderr}`));
      if (overflow) err.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
      else if (!spawnError) err.code = code;
      err.killed = killed;
      err.signal = exited?.signal ?? null;
      err.cmd = shown;
      err.stdout = stdout;
      err.stderr = stderr;
      // #1427 — only a run this function KILLED carries the group it killed.
      if (killed || overflow) err.treePid = child.pid;
      reject(err);
    };

    // Stop the whole tree. The promise then settles on the leader's exit
    // rather than on `close`: a straggler holding the pipe must not hold
    // the driver.
    const stopTree = () => {
      if (killed) return;
      killed = true;
      killGroup(child, "SIGTERM");
      setTimeout(() => killGroup(child, "SIGKILL"), opts.killGraceMs ?? KILL_GRACE_MS).unref();
      if (exited) settle();
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => {
      if (overflow) return;
      stdout += d;
      if (stdout.length > maxBuffer) {
        stdout = stdout.slice(0, maxBuffer);
        overflow = "stdout";
        stopTree();
      }
    });
    child.stderr?.on("data", (d: string) => {
      if (overflow) return;
      stderr += d;
      if (stderr.length > maxBuffer) {
        stderr = stderr.slice(0, maxBuffer);
        overflow = "stderr";
        stopTree();
      }
    });
    child.on("error", (err) => settle(err));
    child.on("exit", (code, signal) => {
      exited = { code, signal };
      if (killed) settle();
    });
    child.on("close", () => settle());
    if (opts.timeout && opts.timeout > 0) timer = setTimeout(stopTree, opts.timeout);
  });
}
