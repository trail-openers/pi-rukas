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
import { provisionWorktree } from "./worktree-provision.ts";
import {
  type DirtyWorktreeFinding,
  type ExecFn,
  salvageDirtyWorktree,
  scanWorktrees,
  worktreePrune,
  worktreeRemove,
} from "./worktree.ts";

/**
 * A leftover worktree discovered by the branch step, with its inspection
 * verdict: clean (no uncommitted files, no commits ahead of `fromRef`) or
 * dirty (the `finding` carries what a removal would destroy).
 */
export interface SameIssueLeftover {
  /** Absolute path of the worktree (`.worktrees/issue-<N>-<id>`). */
  path: string;
  /** Basename under `.worktrees/`. */
  name: string;
  /** True when `inspectWorktreeForLoss` found uncommitted or unpushed work. */
  dirty: boolean;
  finding: DirtyWorktreeFinding | undefined;
}

/**
 * The branch step's disposition of one leftover: adopted (reused in place)
 * or removed (preserved first when dirty, nothing to preserve when clean).
 * The driver turns these into the `worktree-leftover-handled` events and
 * the plumb report, so "which it did" is machine-readable and in the
 * handoff, never implicit.
 */
export interface LeftoverAction {
  leftover: SameIssueLeftover;
  action: "adopt" | "removed";
  /** Durable references created for the removed work (empty for a clean removal). */
  refs: string[];
  /**
   * Scratch salvage dir when a dirty tree's diff was preserved. The
   * sentinel `"(salvage-failed)"` marks a dirty tree whose salvage failed
   * partway (the tree was still removed) so the event records the loss
   * instead of looking identical to a clean removal.
   */
  salvageDir?: string;
}

/**
 * Scan `git worktree list` for ATTACHED worktrees under
 * `.worktrees/issue-<N>`, for every issue number given. Returns ALL hits
 * (clean and dirty) — the residue pass needs both dispositions.
 *
 * The scan itself lives in `scanWorktrees` (worktree.ts), shared with the
 * #545 dirty-sibling guard `findDirtySameIssueLeftover` (first dirty hit
 * of the same scan): one copy of the porcelain parsing and the
 * `inspectWorktreeForLoss` loop, two call shapes.
 *
 * An unreadable list yields an empty result (the branch step then degrades
 * to the pre-#730 behaviour: the raw git error from `worktree add`, plumbed
 * as today), which is the safe direction: refusing to act, not acting
 * wrong.
 */
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

/**
 * The branch step's residue pass.
 *
 * For every same-issue leftover (see `findSameIssueLeftovers`):
 *
 *  - a clean leftover at `fromRef` is ADOPTED when `adoptable` names it —
 *    the cycle's own worktree from a prior run, reusable as-is. It is
 *    RE-PROVISIONED after adoption (`provisionWorktree`, the same idempotent
 *    call `worktreeCreate` makes at create time): an adopted worktree
 *    predates its symlinks' lifetime (a restart wiped the state file but
 *    not the tree), so a stale or absent `node_modules` link is exactly
 *    what the provisioner is for. Provisioning failures are surfaced
 *    (trace + nothing fatal) — a provisioning failure degrades the adopted
 *    tree to the pre-#730 status quo (a bare worktree), never to a
 *    crashed cycle.
 *  - a clean leftover that is NOT adoptable (a different id, or not at
 *    `fromRef`) is removed — it holds nothing, so no preservation.
 *  - a dirty leftover is PRESERVED first (shared recipe
 *    `salvageDirtyWorktree`: salvage patch into the cycle's scratch dir +
 *    a durable tag on the worktree's HEAD) and then removed. Removal is
 *    the only way the branch step can proceed; the preservation is what
 *    makes that removal acceptable.
 *
 * A leftover that cannot be removed (git error) is skipped and its path is
 * returned in `unresolved` — the caller (runBranch) then refuses via the
 * existing #545/DirtyWorktreeError path rather than ploughing into the same
 * collision. Foreign-issue worktrees are never seen by this function.
 *
 * Returns per-leftover actions and the unresolved paths. Never throws:
 * residue handling must not turn a restartable cycle into a crashed one.
 */
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
  // Both sides of the adoption check resolved via `realpathSync` — macOS
  // /tmp is a symlink to /private/tmp, and `worktreePath` may not agree
  // with `git worktree list` on the canonical form. The same pattern as
  // `sweepBranchHolders` in worktree.ts.
  const resolvePath = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  for (const leftover of leftovers) {
    // Clean leftover at the cycle's target path → adopt (reuse knowingly).
    if (!leftover.dirty && adoptable && resolvePath(leftover.path) === resolvePath(adoptable)) {
      // Re-provision the adopted tree (idempotent — the same call
      // worktreeCreate makes at create time): an adopted worktree is from
      // a prior cycle and may lack the dependency symlinks the develop
      // step needs, or have stale ones.
      const provision = await provisionWorktree(execFn, repoRoot, leftover.path).catch((err) => {
        trace(
          `worktree-leftover: provisioning of adopted ${leftover.path} failed (non-fatal): ${(err as Error).message?.slice(0, 200)}`,
        );
        return undefined as import("./worktree-provision.ts").ProvisionResult | undefined;
      });
      trace(
        `worktree-leftover: adopted clean worktree ${leftover.path}` +
          (provision?.problem ? ` (provision problem: ${provision.problem})` : ""),
      );
      actions.push({ leftover, action: "adopt", refs: [] });
      continue;
    }
    // Clean leftover, not adoptable → nothing to preserve, remove it.
    // Dirty leftover → preserve first, then remove. The finding is already
    // in hand (the pass inspected it in findSameIssueLeftovers) — thread
    // it through instead of re-scanning the tree about to be removed.
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
      // Unremovable: do NOT adopt a dirty tree we could not inspect-then-
      // clean — the existing refusal path handles it with the full finding.
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
