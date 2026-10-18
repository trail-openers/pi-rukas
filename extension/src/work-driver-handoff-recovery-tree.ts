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

/** The snapshot proved repoRoot is not a git repository. */
function repoRootNotARepo(ps: WorkState["pipelineState"]): boolean {
  return (ps.handoffSnapshot?.unreadable ?? []).some(
    (f) => f.startsWith("git rev-parse HEAD in ") && /not a git repository/i.test(f),
  );
}

/** Workstream worktrees still on disk at handoff, as `[id, path]`. */
function recoveryWorktrees(ps: WorkState["pipelineState"]): Array<[string, string]> {
  const recorded = Object.entries(ps.worktrees ?? {});
  const retained = ps.handoffSnapshot?.retainedWorktrees;
  // Teardown reports what it kept; absent (teardown off or failed) means the
  // recorded worktrees were never removed.
  if (!retained) return recorded;
  return retained.map((p, i) => [recorded.find(([, path]) => path === p)?.[0] ?? `${i + 1}`, p]);
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
    return [
      "# 1. Inspect what survived in each workstream worktree before deciding:",
      ...wts.flatMap(([, wt]) => [`git -C ${wt} status`, `git -C ${wt} diff --stat`]),
      "",
      ...discard,
      "",
      "# 3. Take over manually — commit + push each worktree's work, open the PR yourself:",
      ...wts.flatMap(([id, wt]) => [
        `git -C ${wt} add -p`,
        `git -C ${wt} commit`,
        `git -C ${wt} push origin HEAD:refs/heads/${wts.length > 1 ? `${branch}-${id}` : branch}`,
      ]),
    ];
  }
  if (repoRootNotARepo(ps)) {
    return [
      "# No git repository was found: repoRoot is not a checkout (see the",
      "# worktree state above) and no workstream worktree was recorded.",
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
