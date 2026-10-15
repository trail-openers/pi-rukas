/**
 * #1153 — an `ExecFn`-shaped promisified exec that honours `argv`. Driver git
 * calls pass argv (`execGit`), and a bare `child_process.exec` would drop it and
 * run a bare `git` (the #1279 trap). Shell-string calls still go through exec.
 */
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";

const execShell = promisify(exec);
const execFileP = promisify(execFile);

export const argvAwareExec = (
  cmd: string,
  o?: { cwd?: string; shell?: string; maxBuffer?: number; argv?: string[] },
) =>
  o?.argv
    ? execFileP(cmd, o.argv, { cwd: o.cwd, maxBuffer: o.maxBuffer })
    : execShell(cmd, { cwd: o?.cwd, shell: o?.shell, maxBuffer: o?.maxBuffer });
