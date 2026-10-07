/**
 * lens-exec — the shared shell executor for the lens review's diff and head
 * reads (lens-review-diff.ts and lens-review.ts).
 *
 * Both modules needed a `VerifyExecFn`-shaped executor for their `git` reads
 * (the ledger-path seam and the ref resolution each take one). Keeping ONE
 * exported instance (item 6b of the #973 review fixes) means the two paths
 * share the exact same argv contract instead of each defining its own
 * closure over `exec`.
 */

import { exec, execFile } from "node:child_process";
import type { VerifyExecFn } from "./work-driver-git.ts";

/** The ONE shell executor the lens review's git reads go through.
 * #1005 — argv form: when `opts.argv` is present, `cmd` is the executable
 * and `argv` its arguments, run via execFile (no shell re-parse). When
 * absent, the classic shell path runs. */
export const execp: VerifyExecFn = (cmd, opts) => {
  const { argv, ...rest } = (opts ?? undefined) as {
    argv?: string[];
    cwd?: string;
    timeout?: number;
    maxBuffer?: number;
    shell?: string;
  };
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
