/**
 * #1634 — a temp dir the adversarial gate can read a diff in.
 *
 * The gate no longer treats a failed `git diff` as an empty (approved) diff:
 * an unreadable worktree halts with `adversarial-diff-unreadable`. Fixtures
 * that point `worktrees` at a bare temp dir (or a path under it) relied on the
 * old fail-open read, so they get a repo with one empty commit instead. A path
 * below the repo root reads the same (empty) diff once it exists.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** `mkdtempSync(tmpdir()/prefix)` that is also a git repo at an empty commit. */
export function mkReadableTmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

/** Create each worktree path (under a `mkReadableTmp` repo) so git can run there. */
export function mkReadableTrees(trees: Record<string, string>): Record<string, string> {
  for (const p of Object.values(trees)) mkdirSync(p, { recursive: true });
  return trees;
}
