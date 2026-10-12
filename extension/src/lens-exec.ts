/**
 * lens-exec — the shared shell executor for the lens review's diff and head
 * reads (lens-review-diff.ts and lens-review.ts).
 *
 * Both modules needed a `VerifyExecFn`-shaped executor for their `git` reads
 * (the ledger-path seam and the ref resolution each take one). Keeping ONE
 * exported instance (item 6b of the #973 review fixes) means the two paths
 * share the exact same argv contract instead of each defining its own
 * closure over `exec`.
 *
 * #1095 — `opts.killGroup` runs the command in its own process group and, on
 * `timeout`, SIGKILLs the whole group. Node's exec timeout kills only the
 * direct child, and an ssh grandchild that inherited stdout keeps the pipe
 * open, so the exec callback never fires and the orphan lives on. Only the
 * driver's network git calls set it (work-driver-net-git.ts).
 */

import { exec, execFile, spawn } from "node:child_process";
import type { VerifyExecFn } from "./work-driver-git.ts";

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
 * absent, the classic shell path runs. */
export const execp: VerifyExecFn = (cmd, opts) => {
  const { argv, killGroup, ...rest } = (opts ?? undefined) as ExecOpts;
  if (killGroup) return execGroup(cmd, argv, rest);
  if (argv) {
    return new Promise<{ stdout: string; stderr?: string }>((resolve, reject) =>
      execFile(cmd, argv, { ...rest, encoding: "utf8" }, (err, stdout, stderr) =>
        err ? reject(err) : resolve({ stdout, stderr }),
      ),
    );
  }
  return new Promise<{ stdout: string; stderr?: string }>((resolve, reject) =>
    exec(cmd, { ...rest, encoding: "utf8" }, (err, stdout, stderr) =>
      err ? reject(err) : resolve({ stdout, stderr }),
    ),
  );
};
