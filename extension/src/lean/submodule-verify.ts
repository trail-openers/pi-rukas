/**
 * lean/submodule-verify — how this step checks its own work, allowed to be WRONG in only one
 * direction: towards refusing the run. A seeding that reports success without looking — a run that
 * tests against an empty `vendor/` directory — is the failure mode this step exists to avoid. Both
 * checks are deliberately pessimistic: an unreadable answer counts as a problem, never as an absence.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { NO_HOOKS } from "./submodule-reads.ts";

/**
 * Whether the tree at `sub` holds `file`, as far as this step is allowed to care. One rule: an
 * answer it could not get may never read as "nothing is missing". `existsSync` swallows every
 * error but `ENOENT` and answers `false`, so the honest way to keep an unreadable path alive as a
 * defect is to ask git first — a path the platform refuses lands as a child that did not run
 * cleanly, and the answer is `true`. `true` on a clean "not there" is never chosen.
 */
export function checkoutHolds(wt: string, sub: string, file: string): boolean {
  const probe = spawnSync("git", [...NO_HOOKS, "rev-parse", "--git-dir"], {
    cwd: path.join(wt, sub),
    encoding: "utf8",
    timeout: 30_000,
  });
  // 0 = a git dir we could read; 1/128 = git said there is none, the ordinary absence this check is
  // for; anything else (a signal, a timeout, a git it could not spawn — `error` is Node's marker)
  // is a path this step could not look down.
  const cleanAbsence = probe.status === 1 || probe.status === 128;
  if (probe.error !== undefined || (probe.status !== 0 && !cleanAbsence)) return true;
  return existsSync(path.join(wt, sub, file));
}

/**
 * The three places a rejected child's reason can live, in the release's own order. The handback an
 * operator reads has to carry the child's own words: a `submodule update` that failed because git
 * could not reach a URL says so on stderr, and dropping it leaves no way to tell a dead network
 * from a broken base.
 */
export function describe(err: unknown): string {
  const e = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return [e.stdout, e.stderr, e.message]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join("\n");
}
