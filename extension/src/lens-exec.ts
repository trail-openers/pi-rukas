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

import { exec } from "node:child_process";
import type { VerifyExecFn } from "./work-driver-git.ts";

/** The ONE shell executor the lens review's git reads go through. */
export const execp: VerifyExecFn = (cmd, opts) =>
  new Promise<{ stdout: string; stderr?: string }>((resolve, reject) =>
    exec(cmd, { ...opts, encoding: "utf8" }, (err, stdout, stderr) =>
      err ? reject(err) : resolve({ stdout, stderr }),
    ),
  );
