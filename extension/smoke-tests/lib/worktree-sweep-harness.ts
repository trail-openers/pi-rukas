/**
 * #1454 r2 — shared harness for the worktree-sweep suites.
 *
 * Split out of test-work-driver-worktree-sweep-reap.ts for the 500-line gate
 * (AGENTS.md §12). Both sweep suites need a real git repo containing a real
 * linked worktree, and the way you build one is non-obvious enough that two
 * copies would drift: the `.worktrees/` directory has to exist before
 * `git worktree add`, the ignore rule has to be committed before the tree is
 * created (or `git clean -fdX` is a no-op and a purge assertion tests nothing),
 * and the root has to be canonicalised or every path comparison loses to
 * macOS's `/var` → `/private/var` symlink.
 */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

export const execAsync = promisify(execFile);

/**
 * A scratch git repo with `.worktrees/` in place, ready for `git worktree add`.
 *
 * The root is realpath'd BEFORE anything is built under it. #1454 r2 resolves
 * every containment check through `realpathSync` (item 4), so an owner-index key
 * is the CANONICAL path — and on macOS `tmpdir()` hands back `/var/...`, a
 * symlink to `/private/var`. A test that seeded `/var/f.../wt` and compared it
 * against the index's `/private/var/f.../wt` failed on the symlink rather than
 * on the gate under test. Canonicalising here makes the fixture's paths the same
 * strings the code under test produces.
 */
export async function scratchRepo(prefix = "sweep-ownership-"): Promise<string> {
  const raw = await fs.mkdtemp(join(tmpdir(), prefix));
  const dir = realpathSync(raw);
  await execAsync("git", ["init"], { cwd: dir });
  await execAsync("git", ["config", "user.name", "Test"], { cwd: dir });
  await execAsync("git", ["config", "user.email", "test@test.com"], { cwd: dir });
  await execAsync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: dir });
  await fs.mkdir(join(dir, ".worktrees"), { recursive: true });
  return dir;
}

/** A minimal ExecFn that shells the argv out to real git. */
export async function realGitExecFn(
  cmd: string,
  opts?: { cwd?: string },
): Promise<{ stdout: string; stderr: undefined }> {
  const argv = cmd.startsWith("git ") ? cmd.slice(4).split(/\s+/) : [cmd];
  const { stdout } = await execAsync("git", argv as string[], { cwd: opts?.cwd });
  return { stdout, stderr: undefined };
}

/** A WorkState in exactly the shape the sweep's index and ladder read. */
export function sweepState(opts: {
  issue: number;
  worktrees: Record<string, string>;
  status?: "running" | "merged" | "handoff" | "aborted" | "interrupted";
  currentStep?: string;
  integrateWorktree?: string;
  ownerPid?: number;
}) {
  const pid = opts.ownerPid ?? 999_999;
  return {
    schemaVersion: 1,
    resumable: false,
    owner: { pid, at: Date.now() - 7_200_000 },
    issue: opts.issue,
    startedAt: Date.now() - 7_200_000,
    updatedAt: Date.now() - 7_200_000,
    pipelineState: {
      currentStep: opts.currentStep ?? "develop",
      inFlightJobIds: [],
      worktrees: opts.worktrees,
      ...(opts.integrateWorktree === undefined
        ? {}
        : { integrateWorktree: opts.integrateWorktree }),
      reviewRound: 0,
      ciRetryCount: 0,
      plumbReports: [],
      status: opts.status ?? "running",
    },
    eventLog: [],
  };
}

/** Write one cycle's state file into a scratch repo. */
export async function writeSweepState(dir: string, issue: number, state: unknown) {
  const stateDir = join(dir, ".pi", "work-state");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(join(stateDir, `${issue}.json`), JSON.stringify(state));
  return stateDir;
}
