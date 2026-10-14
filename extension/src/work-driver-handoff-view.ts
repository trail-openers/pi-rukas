/**
 * work-driver-handoff-view — the ONE interpretation of a handoff snapshot's
 * branch state. The chat message, the GitHub handoff markdown and the
 * /work-status terminal renderer all consume `describeBranchState`, so the
 * wording and the "is this a commit or a modification" rule cannot diverge
 * between surfaces.
 *
 * Capture lives in work-driver-handoff-snapshot.ts; this module only reads the
 * captured snapshot and never shells out.
 */

import type { WorkState } from "./workflow-state.ts";

type Snapshot = WorkState["pipelineState"]["handoffSnapshot"];

/** What a handoff surface says about the branch, derived once from the snapshot. */
export interface BranchStateView {
  /**
   * Text after the branch name, without a leading separator: the branch tip and
   * its distance from base, "branch tip NOT READ", or repoRoot's HEAD (labelled)
   * for a snapshot with no branch tip. Undefined when there is nothing to say.
   */
  tip: string | undefined;
  /** "N uncommitted file(s) (S staged, U unstaged)" when the branch carries commits, else "N file(s) modified (…)". */
  files: string;
  fileCount: number;
  /** True when the branch carries commits, so the file count is uncommitted leftovers. */
  hasCommits: boolean;
  /** The tip exists but its distance from base could not be read. */
  aheadUnknown: boolean;
  /** At least one git read failed — the counts are not evidence. */
  unread: boolean;
}

/** The branch tip as every handoff surface prints it: "tip <sha8>, N commit(s) ahead of base". */
export function branchTipText(
  tip: { sha: string; ahead?: number },
  fmtSha: (sha: string) => string = (sha) => sha,
): string {
  const ahead =
    tip.ahead === undefined
      ? "commits ahead of base unknown (NOT READ)"
      : `${tip.ahead} commit(s) ahead of base`;
  return `tip ${fmtSha(tip.sha.slice(0, 8))}, ${ahead}`;
}

/**
 * Derive the branch-state view from a snapshot. `fmtSha` lets a surface wrap a
 * SHA (markdown backticks). A missing snapshot yields an empty view.
 */
export function describeBranchState(
  snap: Snapshot | undefined,
  fmtSha: (sha: string) => string = (sha) => sha,
): BranchStateView {
  const fileCount = snap ? snap.unstagedCount + snap.stagedCount : 0;
  // `git status --porcelain` counts uncommitted files only. Beside commits the
  // snapshot also reports, "0 file(s) modified" reads as "nothing was built"
  // (#1286), so there the count is labelled as what it is.
  const hasCommits = Boolean(snap?.committedWork?.length) || (snap?.branchTip?.ahead ?? 0) > 0;
  // An unknown branch distance is not "nothing committed": the count is still
  // uncommitted leftovers, so every surface labels it that way.
  const aheadUnknown = snap?.branchTip !== undefined && snap.branchTip.ahead === undefined;
  const fileLabel = hasCommits || aheadUnknown ? "uncommitted file(s)" : "file(s) modified";
  const detail =
    snap && fileCount > 0 ? ` (${snap.stagedCount} staged, ${snap.unstagedCount} unstaged)` : "";
  let tip: string | undefined;
  if (snap?.branchTip) tip = branchTipText(snap.branchTip, fmtSha);
  else if (snap?.branchTipNotRead) tip = "branch tip NOT READ";
  else if (snap?.repoRootHeadSha) tip = `repo-root HEAD ${fmtSha(snap.repoRootHeadSha)}`;
  return {
    tip,
    files: `${fileCount} ${fileLabel}${detail}`,
    fileCount,
    hasCommits,
    aheadUnknown,
    unread: (snap?.unreadable?.length ?? 0) > 0,
  };
}
