/**
 * smoke-tests/lib/lean-build-git — the git identity and the git runner every lean-build fixture
 * child runs under. Split from `lean-build-fixture.ts` (AGENTS.md §12): the fixture builds a repo
 * and a run; this is the small contract its git children need — an identity in the child's own
 * environment, so a commit inside a case is attributed and never reaches a real config.
 */

import { spawnSync } from "node:child_process";
import { gitTestEnv } from "./git-test-env.ts";

/** The identity every git child runs with, the production commit included. */
export function gitEnv(): Record<string, string> {
  return {
    ...gitTestEnv(),
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

/** The same identity, for the challenge fixture's own git children. */
export function gitEnvFor(): Record<string, string> {
  return gitEnv();
}

/** git in `dir`, with an identity in the child's environment. */
export function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv() });
  if (r.status !== 0)
    throw new Error(`git ${args.join(" ")} failed in ${dir}: ${(r.stderr ?? "").trim()}`);
  return (r.stdout ?? "").trim();
}
