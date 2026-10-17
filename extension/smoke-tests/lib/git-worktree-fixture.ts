/**
 * Test fixture (#1016): real git worktrees with one base commit each, for the
 * develop-fanout smoke tests. A develop green needs commits ahead of its base,
 * so fixtures that stage a passing developer must make real commits.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { gitTestEnv } from "./git-test-env.ts";

/**
 * The safety net's `git commit` runs through the inherited environment, not
 * through gitIn's per-call `-c` flags. A CI runner has no global git identity,
 * so the commit fails with "Author identity unknown" and the test sees no commit.
 * Call this at the top of every test file that commits through the safety net.
 * It supplies an identity to this test process only (never `git config --global`),
 * and keeps any identity the operator already has.
 */
export function ensureGitIdentity(): void {
  for (const [key, value] of Object.entries({
    GIT_AUTHOR_NAME: "pi-rukas test",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "pi-rukas test",
    GIT_COMMITTER_EMAIL: "t@t",
  })) {
    process.env[key] ??= value;
  }
}

export function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf8",
    // #1145 — `execFileSync` with no `env` inherits the REAL `environ` on bun
    // 1.3, so a test that never called `gitTestEnv()` itself (or ran outside
    // lib/verify-loop.sh, which exports the isolated set for the whole run)
    // built its throwaway repo against the operator's global git config. That
    // is the same leak the seven host-red fixtures had, one level down: the
    // helper is shared, so the leak was inherited by every suite importing it.
    env: gitTestEnv(),
  }).trim();
}

/** #1016 — the mock developer's work: task-c leaves its edit UNCOMMITTED (the
 *  case the #622 safety net commits); every other developer commits. */
export function mockDeveloperWork(cwd: string, label: string | undefined): void {
  if (label === "developer[task-c]") writeFileSync(path.join(cwd, "edit.txt"), "uncommitted");
  else gitIn(cwd, ["commit", "--allow-empty", "-qm", `work ${label}`]);
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
