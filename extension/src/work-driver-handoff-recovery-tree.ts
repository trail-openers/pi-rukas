/**
 * work-driver-handoff-recovery-tree — the generic "inspect / discard / take
 * over" recovery block, built from the trees the handoff snapshot actually
 * found (#1565). Shared by both handoff renderers; the lines are the
 * markdown surface's literals (bare `git` = repoRoot, cwd-relative `.pi/`),
 * which the chat presenter re-qualifies with `requalifyLine`.
 *
 * The work lives in the workstream worktrees, not at repoRoot, so each
 * retained worktree gets its own `git -C <worktree>` commands. repoRoot's
 * commands are offered only when no worktree was recorded AND the snapshot
 * did not prove repoRoot is not a git repository — printing `git status`
 * at a directory the same handoff just reported as "not a git repository"
 * hands the operator a `fatal:` line.
 *
 * Every line is a single unchained command: they land in the Pi chat, where
 * the permission matcher cannot wildcard `a && b`.
 */

import type { WorkState } from "./workflow-state.ts";

/** The snapshot's read `<prefix>…` failed with "not a git repository". */
function provedNotARepo(ps: WorkState["pipelineState"], prefix: string): boolean {
  return (ps.handoffSnapshot?.unreadable ?? []).some(
    (f) => f.startsWith(prefix) && /not a git repository/i.test(f),
  );
}

/**
 * Workstream worktrees still on disk at handoff and readable by git, as
 * `[id, path]`. Ids come from the RECORDED map, so the per-workstream branch
 * suffix agrees with `unreadableSnapshotLines`; teardown reports real paths,
 * so a retained path that is not a literal match is matched by basename.
 */
function recoveryWorktrees(ps: WorkState["pipelineState"]): Array<[string, string]> {
  const recorded = Object.entries(ps.worktrees ?? {});
  const retained = ps.handoffSnapshot?.retainedWorktrees;
  const base = (p: string) => p.replace(/\/+$/, "").split("/").pop();
  const idOf = (p: string, i: number) =>
    (recorded.find(([, r]) => r === p) ?? recorded.find(([, r]) => base(r) === base(p)))?.[0] ??
    `${i + 1}`;
  // Teardown reports what it kept; absent (teardown off or failed) means the
  // recorded worktrees were never removed.
  const present: Array<[string, string]> = retained
    ? retained.map((p, i) => [idOf(p, i), p])
    : recorded;
  // A worktree whose own `git status` read proved it is not a repository
  // (e.g. its `.git` file points into a repoRoot that is not one) is no tree.
  return present.filter(([, wt]) => !provedNotARepo(ps, `git status in ${wt}:`));
}

export function genericRecoveryLines(state: WorkState): string[] {
  const ps = state.pipelineState;
  const branch = ps.branchName ?? "<branch>";
  const discard = [
    "# 2. Discard the cycle and start over (worktree changes are kept):",
    `rm .pi/work-state/${state.issue}.json`,
  ];
  const wts = recoveryWorktrees(ps);
  if (wts.length > 0) {
    // Same suffix rule as `unreadableSnapshotLines`: decided by the RECORDED
    // workstreams, so one retained worktree of two never pushes as the branch.
    const several = Math.max(Object.keys(ps.worktrees ?? {}).length, wts.length) > 1;
    // origin already has the cycle's branch: a detached worktree HEAD may be
    // behind it, and a push to it would be rejected as non-fast-forward.
    const onOrigin = ps.handoffSnapshot?.branchPushed === true || ps.prNumber !== undefined;
    const intoExisting = !several && onOrigin;
    const existing = ps.prNumber !== undefined ? `${branch} (PR #${ps.prNumber})` : branch;
    return [
      "# 1. Inspect what survived in each workstream worktree before deciding:",
      ...wts.flatMap(([, wt]) => [`git -C ${wt} status`, `git -C ${wt} diff --stat`]),
      "",
      ...discard,
      "",
      intoExisting
        ? `# 3. Take over manually — origin already has ${existing}; commit here, then compare with it before updating it (a push from this HEAD may be rejected as non-fast-forward):`
        : "# 3. Take over manually — commit + push each worktree's work, open the PR yourself:",
      ...wts.flatMap(([id, wt]) => [
        `git -C ${wt} add -p`,
        `git -C ${wt} commit`,
        intoExisting
          ? `git -C ${wt} log --oneline HEAD --not origin/${branch}`
          : `git -C ${wt} push origin HEAD:refs/heads/${several ? `${branch}-${id}` : branch}`,
      ]),
    ];
  }
  if (provedNotARepo(ps, "git rev-parse HEAD in ")) {
    return [
      "# No git repository was found: repoRoot is not a checkout and no",
      "# workstream worktree readable by git was recorded (see the worktree state above).",
      "# 1. Read what the failing step actually reported:",
      `cat .pi/work-state/${state.issue}.json`,
      "",
      ...discard,
    ];
  }
  return [
    "# 1. Inspect what survived before deciding:",
    "git status",
    "git diff --stat",
    "",
    ...discard,
    "",
    "# 3. Take over manually — commit + push what's there, open the PR yourself:",
    "git add -p",
    "git commit",
    `git push -u origin ${branch}`,
  ];
}
