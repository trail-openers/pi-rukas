/**
 * worktree-leftover — #730 same-issue worktree residue at the branch step.
 *
 * `/work N --restart` wiped the state file but left the previous cycle's
 * worktrees (and local feature branch) on disk, so the restarted cycle's
 * `git worktree add` collided with the residue and the branch step failed
 * before creating anything — a restart was reliably impossible after any
 * parked cycle. The same residue also survived a MERGED cycle (#723),
 * because only runMerged tore worktrees down.
 *
 * This module is the branch step's same-issue residue handler. It scans
 * `git worktree list` for worktrees whose path sits under
 * `.worktrees/issue-<N>-*` (the direct scan the #730 gate resolution
 * requires — NOT the state-file-keyed sweep, whose `${name}.json` lookup
 * can never match because state files are keyed by issue number) and, for
 * each leftover, either:
 *
 *  - ADOPTS it (a cycle's own worktree at the target path, clean): reused
 *    knowingly, re-provisioned, nothing destroyed; or
 *  - PRESERVES then REMOVES it: a salvage patch + untracked manifest land
 *    in the cycle's scratch dir and the worktree's HEAD gets a durable
 *    tag (`pi-rukas-salvage/<name>/<timestamp>`) BEFORE
 *    `git worktree remove --force`, so unpushed commits are recoverable.
 *
 * The shared seams this module calls (each lives in one place so the two
 * sites cannot drift):
 *
 *  - `scanWorktrees` (worktree.ts) — the porcelain scan; the #730 scan
 *    (`findSameIssueLeftovers`, all hits) and the #545 dirty-sibling
 *    guard (`findDirtySameIssueLeftover`, first dirty hit) both build on
 *    it.
 *  - `salvageDirtyWorktree` (worktree-salvage.ts) — the salvage recipe
 *    (uncommitted-work patch + durable tag on HEAD) shared with the #545
 *    salvage (work-driver-branch-salvage.ts).
 *
 * Scoping: only `.worktrees/issue-<N>-*` for the cycle's OWN issue(s). A
 * concurrent cycle legitimately owns `.worktrees/issue-<M>-*` (M ≠ N) and
 * is never touched — the same boundary #545's salvage already honours.
 * The local `feature/issue-N` branch is handled separately (it is created
 * lazily by `integrate()` and never by worktree machinery, so it can only
 * be handled there, not here).
 */

import { realpathSync } from "node:fs";
import path from "node:path";
import { trace } from "./trace.ts";
import { type ProvisionResult, provisionWorktree } from "./worktree-provision.ts";
import {
  type DirtyWorktreeFinding,
  type ExecFn,
  salvageDirtyWorktree,
  scanWorktrees,
  worktreePrune,
  worktreeRemove,
} from "./worktree.ts";

export interface SameIssueLeftover {
  path: string;
  name: string;
  dirty: boolean;
  finding: DirtyWorktreeFinding | undefined;
}

export interface LeftoverAction {
  leftover: SameIssueLeftover;
  action: "adopt" | "removed";
  refs: string[];
  salvageDir?: string;
}

export async function findSameIssueLeftovers(
  execFn: ExecFn,
  repoRoot: string,
  fromRef: string,
  issueNumbers: number[],
): Promise<SameIssueLeftover[]> {
  const prefixes = issueNumbers.map((n) => `.worktrees${path.sep}issue-${n}`);
  const hits = await scanWorktrees(execFn, repoRoot, fromRef, prefixes);
  return hits.map((h) => ({
    path: h.path,
    name: h.name,
    dirty: h.finding !== undefined,
    finding: h.finding,
  }));
}

export async function handleSameIssueLeftovers(
  execFn: ExecFn,
  repoRoot: string,
  fromRef: string,
  issueNumbers: number[],
  scratch: string,
  adoptable?: string,
): Promise<{ actions: LeftoverAction[]; unresolved: string[] }> {
  const leftovers = await findSameIssueLeftovers(execFn, repoRoot, fromRef, issueNumbers);
  const actions: LeftoverAction[] = [];
  const unresolved: string[] = [];
  const resolvePath = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  for (const leftover of leftovers) {
    if (!leftover.dirty && adoptable && resolvePath(leftover.path) === resolvePath(adoptable)) {
      const provision = await provisionWorktree(execFn, repoRoot, leftover.path).catch((err) => {
        trace(
          `worktree-leftover: provisioning of adopted ${leftover.path} failed (non-fatal): ${(err as Error).message?.slice(0, 200)}`,
        );
        return undefined as ProvisionResult | undefined;
      });
      trace(
        `worktree-leftover: adopted clean worktree ${leftover.path}${provision?.problem ? ` (provision problem: ${provision.problem})` : ""}`,
      );
      actions.push({ leftover, action: "adopt", refs: [] });
      continue;
    }
    const preserve = leftover.dirty
      ? await salvageDirtyWorktree(
          execFn,
          repoRoot,
          leftover.path,
          fromRef,
          scratch,
          leftover.finding,
        ).catch((err) => {
          trace(
            `worktree-leftover: preservation of ${leftover.path} failed: ${(err as Error).message?.slice(0, 200)}`,
          );
          return { refs: [] as string[], salvageDir: undefined as string | undefined };
        })
      : { refs: [] as string[] };
    try {
      await worktreeRemove(execFn, repoRoot, leftover.name, true);
    } catch (err) {
      trace(
        `worktree-leftover: removal of ${leftover.path} failed: ${(err as Error).message?.slice(0, 200)}`,
      );
      unresolved.push(leftover.path);
      continue;
    }
    actions.push({
      leftover,
      action: "removed",
      refs: preserve.refs,
      salvageDir: preserve.salvageDir,
    });
  }
  if (actions.length > 0) {
    await worktreePrune(execFn, repoRoot).catch(() => undefined);
  }
  return { actions, unresolved };
}
