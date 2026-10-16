/**
 * #1153 — an `ExecFn`-shaped promisified exec that honours `argv`. Driver git
 * calls pass argv (`execGit`), and a bare `child_process.exec` would drop it and
 * run a bare `git` (the #1279 trap). Shell-string calls still go through exec.
 *
 * `timeout` is forwarded on BOTH branches: a driver git call carries its own
 * bounded timeout (`DEFAULT_GIT_TIMEOUT_MS`), and a harness that ignores it
 * turns a hung git into a hung smoke test.
 */
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execShell = promisify(exec);
const execFileP = promisify(execFile);

export const argvAwareExec = (
  cmd: string,
  o?: { cwd?: string; shell?: string; maxBuffer?: number; timeout?: number; argv?: string[] },
) =>
  o?.argv
    ? execFileP(cmd, o.argv, { cwd: o.cwd, maxBuffer: o.maxBuffer, timeout: o.timeout })
    : execShell(cmd, {
        cwd: o?.cwd,
        shell: o?.shell,
        maxBuffer: o?.maxBuffer,
        timeout: o?.timeout,
      });
