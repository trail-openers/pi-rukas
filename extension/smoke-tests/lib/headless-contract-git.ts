/**
 * Fixture git helpers for `test-headless-host-contract.ts` (#1981).
 *
 * They live here rather than inline because the file they serve sits at the
 * AGENTS.md §12 line cap, and the cap is never met by shortening the prose that
 * explains what a case proves. The seam is the one the helpers already were:
 * throwaway repositories with commits, built the way a checkout is built.
 *
 * Every call threads `gitTestEnv()`: isolated host config (#1145) AND no
 * inherited git location variables (#1981). `execFileSync` with no `env` option
 * inherits the real `environ`, and git honours `GIT_DIR`/`GIT_WORK_TREE` ahead
 * of `-C <dir>` — so an unthreaded `git commit` here writes fixture commits
 * into whoever's repository those variables name, and exits 0 doing it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { gitTestEnv } from "./git-test-env.ts";

const IDENTITY = ["-c", "user.email=t@t", "-c", "user.name=t"] as const;

/** One empty commit in `dir`, under the fixture's isolated git view. */
export function gitCommit(dir: string): void {
  execFileSync("git", ["-C", dir, ...IDENTITY, "commit", "-q", "--allow-empty", "-m", "x"], {
    env: gitTestEnv(),
  });
}

/** `dir`'s HEAD sha. */
export function headOf(dir: string): string {
  return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env: gitTestEnv(),
  }).trim();
}

/** `git init` a throwaway repository at `dir` with one commit; returns `dir`. */
export function mkRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir], { env: gitTestEnv() });
  gitCommit(dir);
  return dir;
}
