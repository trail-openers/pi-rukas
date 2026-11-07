/**
 * lib/lean-verify-git — the one git voice the verify fixture and its byte module
 * share, plus the sha form the frozen record uses.
 *
 * A frozen file's record is the sha256 of the bytes the freeze COMMITTED, and every
 * tamper case has to break a real byte to be red, so "run git as the fixture's
 * identity" and "hash it the way the freeze does" are facts more than one module
 * needs. Keeping them here is what lets the byte module commit files without
 * carrying its own `spawnSync` and its own identity block.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { gitTestEnv } from "./git-test-env.ts";

function gitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

/** git in `dir`, with an identity in the child's environment. */
export function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}

/** The fixture's git identity, for a caller that spawns git itself. */
export function fixtureGitEnv(): Record<string, string> {
  return gitEnv();
}

/** The sha256 of a string's bytes, the way the freeze records them. */
export function sha(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}
