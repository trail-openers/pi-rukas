/**
 * worktree-create-guard — the pre-add guards of `worktreeCreate` (split
 * from worktree.ts for the AGENTS.md §12 500-line cap; same seam as
 * worktree-provision.ts / worktree-salvage.ts: a focused helper module
 * that worktree.ts calls and re-exports nothing from).
 *
 * Two guards, deliberately split (the six-lens #753 review found the
 * original code skipping BOTH for in-cycle paths — the #475 guard at the
 * TARGET path must never be waived):
 *
 *  1. The SIBLING scan (#545): a dirty SAME-ISSUE leftover anywhere under
 *     `.worktrees/issue-<N>-` that is NOT part of the current cycle. In-cycle
 *     paths are excluded here (an earlier workstream's legitimate in-progress
 *     dirt is not a leftover).
 *  2. The TARGET-path #475 guard: a dirty worktree at the target path —
 *     runs UNCONDITIONALLY, in-cycle membership never waives it. Only the
 *     pre-remove is skipped for an in-cycle path.
 */

import { trace } from "./trace.ts";
import {
  DirtyWorktreeError,
  type DirtyWorktreeFinding,
  type ExecFn,
  findDirtySameIssueLeftover,
  inspectWorktreeForLoss,
  resolvePath,
  worktreePath,
  worktreeRemove,
} from "./worktree.ts";

export interface CreateGuardOpts {
  repoRoot: string;
  name: string;
  fromRef: string;
}

/**
 * Run both pre-add guards. Returns `undefined` when the caller may proceed
 * to `git worktree add`; throws `DirtyWorktreeError` when a guard fired.
 * `inCycleWorktrees` are the worktree paths that belong to the current
 * cycle (created by the branch step or an earlier dependent): they are
 * excluded from the SIBLING scan only — never from the target-path guard.
 */
export async function runCreateGuards(
  execFn: ExecFn,
  opts: CreateGuardOpts,
  inCycleWorktrees?: string[],
): Promise<void> {
  const abs = worktreePath(opts.repoRoot, opts.name);
  // #545 — the mechanism that killed the #540 restart: `worktree add` itself
  // refuses against ANY leftover worktree of the same cycle (e.g. the
  // cycle's OWN dead siblings from a parked run, all named
  // `issue-<N>-<id>`). Inspect what's attached first so a dirty one becomes
  // a refusal WITH salvage instead of a bare `fatal: ... already exists`
  // error. A clean foreign leftover is still handled by `worktree add`'s
  // own path-exists error — unchanged.
  const issuePrefix = opts.name.split("-").slice(0, 2).join("-");
  // #753 — the SIBLING scan excludes this cycle's own worktrees (the exclusion
  // happens inside findDirtySameIssueLeftover, which resolves both sides —
  // an earlier workstream's legitimate in-progress dirt is not a leftover).
  // #753 (six-lens FIX 2) — the sibling scan degrades the SAFE direction:
  // a transient `git worktree list` failure returns "no finding" and creation
  // proceeds EXACTLY as pre-#545 did (the raw git error from `git worktree
  // add`, now plumbed via `gitErrorDetail`). A throw here instead escaped to
  // `create-error` with no dirty finding AND let `git worktree add` proceed
  // onto an UNSCANNED dirty sibling — the shape #545 exists to prevent.
  // This mirrors `scanWorktrees`' documented "unreadable list → empty array
  // — the safe direction (no action)" and `inspectWorktreeForLoss`'s #475
  // fail-open ("an unreadable worktree is removed as today").
  const siblingDirty = await findDirtySameIssueLeftover(
    execFn,
    opts.repoRoot,
    opts.fromRef,
    issuePrefix,
    opts.name,
    inCycleWorktrees,
  ).catch((e) => {
    trace(
      `worktree: sibling scan failed for ${opts.name} — proceeding without it (${e instanceof Error ? e.message : String(e)})`,
    );
    return undefined;
  });
  if (siblingDirty) {
    throw new DirtyWorktreeError(siblingDirty);
  }
  // The TARGET path: the #475 dirty guard runs UNCONDITIONALLY (in-cycle
  // membership never waives it — a dirty pre-existing worktree here still
  // holds work a force-remove would destroy), and the pre-remove is skipped
  // for an in-cycle path (nothing to remove; a clean in-cycle path means
  // `git worktree add`'s own "already exists" error is the signal).
  // #861 — the in-cycle set doubles as the TARGET-path exemption: the
  // caller (ensureIntegrateWorktree) has already force-removed any
  // driver-owned stale tree at this path (recording its HEAD first) or
  // verified the path absent, so a path the caller itself created in this
  // cycle is re-inspected as ABSENT — the guard's `git rev-parse` in a
  // nonexistent directory fails and returns no finding. The SIBLING scan
  // above still runs: a foreign same-issue leftover is still a hazard.
  const inCycleSet = new Set((inCycleWorktrees ?? []).map((p) => resolvePath(p)));
  const targetAbsent = inCycleSet.has(resolvePath(abs));
  const leftover = targetAbsent
    ? undefined
    : await inspectWorktreeForLoss(execFn, opts.repoRoot, abs, opts.fromRef);
  if (leftover) {
    throw new DirtyWorktreeError(leftover);
  }
  // #753 — the in-cycle set: this worktree is part of the current cycle (the
  // branch step or an earlier dependent created it, so it is registered in
  // `git worktree list`). `git worktree list --porcelain` emits symlink-
  // resolved paths (macOS /private/var/…) while `abs` is the logical form
  // (/var/…), so both sides go through the same realpath resolution as the
  // sibling scan.
  if (!inCycleSet.has(resolvePath(abs))) {
    await worktreeRemove(execFn, opts.repoRoot, opts.name, true).catch(() => undefined);
  }
  trace(`worktree: guards passed for ${opts.name} — proceeding to create`);
}

/** Re-export of the finding type for callers of the guard. */
export type { DirtyWorktreeFinding };
