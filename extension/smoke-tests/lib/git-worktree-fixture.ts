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

/** #1016 — the mock developer's work. EVERY mock developer commits, task-c
 *  included.
 *
 *  #1768 changed this helper. task-c used to leave its edit uncommitted and the
 *  assertions still passed, because the #622 safety net committed it — which is
 *  precisely the behaviour #1768 removes: a child that never commits is no
 *  longer certified done by a driver-made commit. The `ahead === 1` assertion in
 *  test-work-driver-workstreams.ts therefore now verifies that a developer that
 *  DOES commit is counted green, which is what it was always meant to show.
 *  The "child left work uncommitted" case lives in test-develop-unfinished.ts,
 *  where it asserts the OPPOSITE outcome (the step parks). */
export function mockDeveloperWork(cwd: string, label: string | undefined): void {
  gitIn(cwd, ["commit", "--allow-empty", "-qm", `work ${label}`]);
}

/** #1768 — the mock developer that does what the develop prompt actually tells
 *  the real one: commit its own work, in ITS OWN worktree (`spec.cwd`).
 *
 *  A developer that returns ok:true without ever committing is the bug #1768
 *  detects, not a shape a fixture may stand in for: pre-fix the #622 safety net
 *  committed it silently and the pass looked green, which is how a mid-step quit
 *  became a completed step and unfinished work reached a PR. A fixture that
 *  mocks a SUCCESSFUL developer must therefore commit in the worktree the
 *  dispatch was given; `repoRoot` is an integration point, not a developer tree,
 *  so committing there is not a substitute and the develop step correctly parks
 *  the cycle as `develop-incomplete-uncommitted`.
 *
 *  Real commits, not faked git output: the develop green is a count of commits
 *  ahead of the workstream's base, so a fixture whose git is stubbed cannot earn
 *  one — see the module header. */
export function mockDeveloperCommit(cwd: string | undefined, label: string | undefined): void {
  if (!cwd) return;
  gitIn(cwd, ["commit", "--allow-empty", "-qm", `developer work ${label ?? ""}`.trim()]);
}

/** Create `<dir>/.worktrees/<id>` as a repo with one base commit; returns id → base SHA. */
export async function makeBaseWorktrees(
  dir: string,
  ids: string[],
): Promise<Record<string, string>> {
  const shas: Record<string, string> = {};
  for (const id of ids) {
    const wt = path.join(dir, ".worktrees", id);
    // #1768 — the develop green is a COUNT of commits ahead of the workstream's
    // base, so the base itself must be readable: an unborn HEAD makes every
    // `rev-list <base>..HEAD` unreadable, and an unreadable count is never
    // evidence of a green (see work-develop-git.ts `commitsAheadOfBase`).
    await mkdir(wt, { recursive: true });
    gitIn(wt, ["init", "-q", "--initial-branch=main"]);
    writeFileSync(path.join(wt, "base.txt"), `${id} base\n`);
    gitIn(wt, ["add", "base.txt"]);
    gitIn(wt, ["commit", "-qm", "base"]);
    shas[id] = gitIn(wt, ["rev-parse", "HEAD"]);
  }
  return shas;
}
