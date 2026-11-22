/**
 * work-driver-stop-teardown — a stopped cycle removes its own worktrees.
 *
 * The handoff walks every tree the cycle recorded: the `pipelineState.worktrees`
 * values, `integrateWorktree`, and the derived `issue-<N>-<id>` path of every key,
 * which is where an owner's original tree stays after a fence merge re-points the
 * key at another tree. Each candidate passes the same containment and identity
 * gate as the launch sweep, so the repo root and foreign directories are never
 * touched. An integration-worktree-violation park keeps the integrate tree: its
 * recovery inspects it.
 *
 * A tree's work that no local branch holds — commits, and its index plus uncommitted
 * or untracked non-ignored files as one snapshot commit on top — goes onto
 * `refs/pi-rukas/stop-salvage/issue-<N>/<tree>/<sha>` before
 * `git worktree remove --force`. The SHA is in the name so a later stop of a
 * same-named tree adds a ref and never moves one. A patch that is already on the
 * feature branch (a consolidation cherry-picked it) needs no ref. A local branch
 * is the bar, not the remote: remote-tracking refs are pruned.
 *
 * Any per-tree failure keeps that tree on disk and names it in `retained`; a tree
 * is never removed when its salvage failed. A merge hold keeps its trees purged,
 * as the human merging may still want them.
 */

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execp } from "./exec.ts";
import { trace } from "./trace.ts";
import type { CycleContext } from "./work-driver-context.ts";
import { hardenedGitArgv, revertGitEnv } from "./work-driver-fix-pass-strays-target.ts";
import { lastCapShape } from "./work-driver-handoff-terminal.ts";
import { withIntegrationLock } from "./work-driver-lock.ts";
import { executeSweepAction, isAwaitingHumanMerge } from "./work-driver-sweep-policy.ts";
import { claimUnderWorktrees } from "./work-driver-worktree-sweep-owners.ts";
import { type SweepTargetResult, resolveSweepTarget } from "./work-driver-worktree-sweep.ts";
import type { WorkState } from "./workflow-state.ts";
import { writeStopSalvageRef } from "./worktree-salvage.ts";
import { type ExecFn, worktreePath, worktreePrune } from "./worktree.ts";

export interface StopTeardown {
  /** Trees left on disk, as resolved paths. */
  retained: string[];
  /** Recorded path strings of the trees that were removed. */
  removed: string[];
  /** Stop-salvage refs written. */
  salvaged: string[];
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

function sha(out: string, what: string): string {
  const s = out.trim();
  if (!SHA.test(s)) throw new Error(`${what} returned ${JSON.stringify(s.slice(0, 64))}`);
  return s;
}

export async function runStopTeardown(ctx: CycleContext, state: WorkState): Promise<StopTeardown> {
  const out: StopTeardown = { retained: [], removed: [], salvaged: [] };
  const ps = state.pipelineState;
  const recorded = [
    ...Object.values(ps.worktrees ?? {}),
    // That cap's recovery inspects the integrate tree, so it stays on disk.
    ...(typeof ps.integrateWorktree === "string" &&
    lastCapShape(state) !== "integration-worktree-violation"
      ? [ps.integrateWorktree]
      : []),
    ...Object.keys(ps.worktrees ?? {}).map((id) =>
      worktreePath(ctx.repoRoot, `issue-${state.issue}-${id}`),
    ),
  ];
  const targets = new Map<string, { target: SweepTargetResult; recorded: string }>();
  for (const p of recorded) {
    const claimed = claimUnderWorktrees(ctx.repoRoot, p);
    const target = claimed === null ? undefined : resolveSweepTarget(ctx.repoRoot, claimed);
    if (!target?.ok) {
      trace(`stop-teardown: skipped ${p}: ${target ? target.reason : "outside-worktrees"}`);
      continue;
    }
    if (!targets.has(target.realPath)) targets.set(target.realPath, { target, recorded: p });
  }
  if (targets.size === 0) return out;
  const execFn: ExecFn = ctx.verifyExecFn ?? execp;
  // `git worktree remove`/`prune` touch the shared admin area a sibling's
  // `worktree add` also writes.
  await withIntegrationLock(ctx.repoRoot, async () => {
    for (const { target, recorded: p } of targets.values()) {
      if (isAwaitingHumanMerge(state)) {
        await executeSweepAction({ type: "purge", target }, execFn).catch((err) =>
          trace(`stop-teardown: purge of ${target.realPath} failed: ${err}`),
        );
        out.retained.push(target.realPath);
        continue;
      }
      try {
        const keep = await unbranchedWork(execFn, target.realPath, ps.branchName);
        if (keep !== undefined) {
          out.salvaged.push(
            await writeStopSalvageRef(execFn, ctx.repoRoot, state.issue, target.name, keep),
          );
        }
        await executeSweepAction({ type: "remove", target }, execFn);
        out.removed.push(p);
      } catch (err) {
        trace(`stop-teardown: kept ${target.realPath}: ${(err as Error).message?.slice(0, 300)}`);
        out.retained.push(target.realPath);
      }
    }
    await worktreePrune(execFn, ctx.repoRoot).catch((err) =>
      trace(`stop-teardown: worktree prune failed: ${err}`),
    );
  });
  return out;
}

/**
 * The commit holding everything in `tree` that no local branch holds, or
 * undefined when every bit of it is on one. Throws when git cannot answer.
 */
async function unbranchedWork(
  execFn: ExecFn,
  tree: string,
  branch: string | undefined,
): Promise<string | undefined> {
  const git = async (args: string[], env?: NodeJS.ProcessEnv) =>
    (
      await execFn("git", {
        cwd: tree,
        maxBuffer: 4 * 1024 * 1024,
        argv: hardenedGitArgv(args),
        env: revertGitEnv(env),
      })
    ).stdout;
  const gitDir = (await git(["rev-parse", "--absolute-git-dir"])).trim();
  const index = join(gitDir, "pi-stop.index");
  const idx = { GIT_INDEX_FILE: index };
  let target: string;
  try {
    rmSync(index, { force: true });
    // Seeded from the tree's own index, so a tracked file that matches .gitignore,
    // force-added or not yet committed, is kept too.
    if (existsSync(join(gitDir, "index"))) copyFileSync(join(gitDir, "index"), index);
    else await git(["read-tree", "HEAD"], idx);
    await git(["add", "-A"], idx);
    const snapshot = sha(await git(["write-tree"], idx), "write-tree");
    const head = sha(await git(["rev-parse", "HEAD"]), "rev-parse HEAD");
    target =
      snapshot === sha(await git(["rev-parse", "HEAD^{tree}"]), "rev-parse HEAD^{tree}")
        ? head
        : sha(
            await git([
              ...["-c", "user.name=pi-rukas", "-c", "user.email=driver@localhost"],
              ...["commit-tree", snapshot, "-p", head, "-m", "pi-rukas: uncommitted work at stop"],
            ]),
            "commit-tree",
          );
  } finally {
    rmSync(index, { force: true });
  }
  // One line of `rev-list -n1` names a commit outside the range; empty means none.
  const listed = (out: string, what: string) => out.trim() !== "" && Boolean(sha(out, what));
  if (!listed(await git(["rev-list", "-n1", target, "--not", "--branches"]), "rev-list")) {
    return undefined;
  }
  if (branch) {
    const local = `refs/heads/${branch}`;
    const has = await git(["rev-parse", "--verify", "--quiet", local]).then(
      () => true,
      () => false,
    );
    const cherry = ["rev-list", "-n1", "--right-only", "--cherry-pick", `${local}...${target}`];
    if (has && !listed(await git(cherry), "rev-list --cherry-pick")) return undefined;
  }
  return target;
}
