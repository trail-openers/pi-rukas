/**
 * Test fixture (#1016): real git worktrees with one base commit each, for the
 * develop-fanout smoke tests. A develop green needs commits ahead of its base,
 * so fixtures that stage a passing developer must make real commits.
 */
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

/** Create `<dir>/.worktrees/<id>` as a repo with one base commit; returns id → base SHA. */
export async function makeBaseWorktrees(
  dir: string,
  ids: string[],
): Promise<Record<string, string>> {
  const shas: Record<string, string> = {};
  for (const id of ids) {
    const wt = path.join(dir, ".worktrees", id);
    await mkdir(wt, { recursive: true });
    gitIn(wt, ["init", "-q"]);
    gitIn(wt, ["commit", "--allow-empty", "-qm", "base"]);
    shas[id] = gitIn(wt, ["rev-parse", "HEAD"]);
  }
  return shas;
}
