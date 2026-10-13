/**
 * lens-exec — the shared shell executor that honours the argv form.
 *
 * It began as the lens review's executor (lens-review-diff.ts and
 * lens-review.ts): both needed a `VerifyExecFn`-shaped executor for their
 * `git` reads, and keeping ONE exported instance (item 6b of the #973 review
 * fixes) means the two paths share the exact same argv contract instead of
 * each defining its own closure over `exec`.
 *
 * It is now also the production stand-in for `ctx.verifyExecFn` in the
 * driver modules that used a bare `promisify(exec)` for it. `VerifyExecFn`
 * declares `argv`, and `promisify(exec)` type-checks as one while silently
 * dropping it — an argv-form call then runs a bare `git`, which prints usage
 * and exits 1 (`Command failed: git`, empty stderr). The merged step's
 * checkout restore reached argv-form calls through such a default.
 * `test-exec-argv-contract.ts` fails if a shell-only executor is handed on
 * as a value again, and lists the few that still are with the reason.
 *
 * #1095 — `opts.killGroup` runs the command in its own process group and, on
 * `timeout`, SIGKILLs the whole group. Node's exec timeout kills only the
 * direct child, and an ssh grandchild that inherited stdout keeps the pipe
 * open, so the exec callback never fires and the orphan lives on. Only the
 * driver's network git calls set it (work-driver-net-git.ts).
 */

import { exec, execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { VerifyExecFn } from "./work-driver-git.ts";

const execShell = promisify(exec);
const execFileP = promisify(execFile);

type ExecOpts = {
  argv?: string[];
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  shell?: string;
  env?: NodeJS.ProcessEnv;
  killGroup?: boolean;
};

/** #1095 — spawn detached, kill the process group on timeout or overflow. */
function execGroup(
  cmd: string,
  argv: string[] | undefined,
  opts: ExecOpts,
): Promise<{ stdout: string; stderr?: string }> {
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
        finish(() => reject(new Error(`command timed out after ${opts.timeout}ms: ${cmd}`)));
      }, opts.timeout);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      stdout += d;
      if (stdout.length > maxBuffer) {
        killGroup();
        finish(() => reject(new Error(`stdout maxBuffer exceeded: ${cmd}`)));
      }
    });
    child.stderr.on("data", (d: string) => {
      // Bounded like stdout: a chatty ssh must not grow memory until the timeout.
      if (stderr.length < maxBuffer) stderr += d;
    });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) =>
      finish(() =>
        code === 0
          ? resolve({ stdout, stderr })
          : reject(
              Object.assign(new Error(`Command failed: ${cmd}\n${stderr}`), {
                code,
                stdout,
                stderr,
              }),
            ),
      ),
    );
  });
}

/** The ONE shell executor the lens review's git reads go through.
 * #1005 — argv form: when `opts.argv` is present, `cmd` is the executable
 * and `argv` its arguments, run via execFile (no shell re-parse). When
 * absent, the classic shell path runs. Either way it settles in
 * `promisify(exec)`'s shape, so a rejection carries `stdout` / `stderr`. */
export const execp: VerifyExecFn = (cmd, opts) => {
  const { argv, killGroup, ...rest } = (opts ?? {}) as ExecOpts;
  if (killGroup) return execGroup(cmd, argv, rest);
  if (argv) return execFileP(cmd, argv, { ...rest, encoding: "utf8" });
  return execShell(cmd, { ...rest, encoding: "utf8" });
};
