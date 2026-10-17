/**
 * #1391 task-e — the REAL-GIT fixture both halves of the severed-lens-fix
 * test share.
 *
 * A cycle whose lens-fix worktree is detached at the branch tip, exactly as
 * the branch step leaves it: a bare "origin" on disk (no network), `main`, a
 * pushed `feature/issue-1391-<name>` branch, one detached worktree under
 * `.worktrees/`, and the driver's scratch dir. `origin/HEAD` is pointed at
 * main so the driver's mainline resolution has an answer.
 *
 * Split from `test-work-driver-retry-dirty-tree.ts` for the AGENTS.md §12
 * 500-line gate; the assertions that use it are in the two
 * `test-work-driver-retry-dirty-tree*.ts` files.
 */

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ExecFn } from "../src/worktree.ts";

const execFileP = promisify(execFile);

/**
 * The real executor, honouring BOTH forms the production seam uses (exec.ts
 * `execp`): argv via execFile (no shell re-parse — #1279), shell strings via
 * `/bin/sh -c`. NOT a login shell: `-l` sources profile files that may `cd`,
 * and the test would silently run git somewhere else.
 */
export const realExec: ExecFn = async (cmd, o) => {
  const opts = { cwd: o?.cwd, maxBuffer: o?.maxBuffer ?? 8 * 1024 * 1024 };
  const { stdout } = o?.argv
    ? await execFileP(cmd, o.argv, opts)
    : await execFileP("/bin/sh", ["-c", cmd], opts);
  return { stdout };
};

export const git = (cwd: string, args: string[]) => execFileP("git", args, { cwd });
export const gitOut = async (cwd: string, args: string[]): Promise<string> =>
  (await git(cwd, args)).stdout.trim();

/** The porcelain as the reposition guard reads it (argv form, like production). */
export const porcelain = async (wt: string): Promise<string> => {
  const { stdout } = await realExec("git", { cwd: wt, argv: ["status", "--porcelain"] });
  return stdout.trim();
};

export interface Fixture {
  root: string;
  repo: string;
  wt: string;
  branch: string;
  baseSha: string;
  scratch: string;
}

/**
 * Build the cycle. `name` namespaces the branch, the worktree and the temp
 * dir so two fixtures from one process cannot collide.
 */
export async function fixture(name: string): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), `pi-ens-1391-${name}-`));
  const repo = path.join(root, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "a.txt"), "base\n");
  await git(repo, ["init", "-q", "--initial-branch=main"]);
  await git(repo, ["config", "user.email", "t@example.com"]);
  await git(repo, ["config", "user.name", "T"]);
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-q", "-m", "base"]);
  const baseSha = await gitOut(repo, ["rev-parse", "HEAD"]);

  const origin = path.join(root, "origin.git");
  await git(root, ["init", "-q", "--bare", "--initial-branch=main", origin]);
  await git(repo, ["remote", "add", "origin", origin]);
  await git(repo, ["push", "-q", "-u", "origin", "main"]);
  await git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

  const branch = `feature/issue-1391-${name}`;
  await git(repo, ["checkout", "-qb", branch]);
  writeFileSync(path.join(repo, "feature.txt"), "const x = eval(input);\n");
  await git(repo, ["add", "feature.txt"]);
  await git(repo, ["commit", "-q", "-m", "feature with bug"]);
  await git(repo, ["push", "-q", "-u", "origin", branch]);

  const wt = path.join(repo, ".worktrees", `issue-1391-${name}`);
  await git(repo, ["worktree", "add", "-q", "--detach", wt, branch]);

  // The driver's scratch dir for this cycle (`scratchDir(repoRoot, issue)`).
  const scratch = path.join(root, "tmp", "issue-1391");
  mkdirSync(scratch, { recursive: true });
  return { root, repo, wt, branch, baseSha, scratch };
}

/**
 * The dead attempt's footprint: a tracked edit, an untracked top-level file,
 * an untracked file in a NEW directory (only `clean -fd` reaches it), and a
 * second tracked edit. Four paths, three kinds of dirt — the mix the seam
 * has to account for completely, because one path left behind re-dirties the
 * tree the retry is about to be dispatched into.
 */
export function severTheAttempt(wt: string): void {
  writeFileSync(path.join(wt, "DESIGN.md"), "# half-written design\n\nsecond paragraph\n");
  writeFileSync(path.join(wt, "feature.txt"), "const x = halfWritten(input);\n");
  writeFileSync(path.join(wt, "scratch-notes.txt"), "untracked notes\n");
  mkdirSync(path.join(wt, "host"), { recursive: true });
  writeFileSync(path.join(wt, "host", "game-view.js"), "// half written\n");
}

/** The save args every call site uses, spread into `cleanWorktreeForRetry`. */
export const saveArgs = (f: Fixture, attempt = 1) => ({
  repoRoot: f.repo,
  worktree: f.wt,
  step: "lens-fix",
  workstreamId: "default",
  attempt,
  scratchDir: f.scratch,
});

/** One real WorkEvent of the shape the router hands the loss line. */
export const severed = {
  kind: "dispatch-failed-provider" as const,
  step: "lens-fix" as const,
  role: "developer",
  jobId: "j-lost",
  label: "developer:lens-fix-2",
  ms: 1_369_000,
  at: 1,
  providerMessage: "terminated",
  usage: { input: 400_000, output: 12_000, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 40 },
};
