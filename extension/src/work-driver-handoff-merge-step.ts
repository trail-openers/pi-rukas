/**
 * work-driver-handoff-merge-step — the #810 step-3 recovery merge command
 * for a parked, consolidated branch.
 *
 * GitHub squashes a single-commit branch with the commit's message instead
 * of the PR title (the #801 `chore(handoff):` misclassification), so the
 * printed command carries the explicit `--subject` the driver's own merge
 * step passes (same flag, same value — the operator following the handoff
 * and the driver running the merged step land identically). The subject is
 * the PR title (read live by the caller, threaded in); when it is
 * unavailable the command degrades to the pre-#810 form (no subject flag)
 * rather than a stale or placeholder subject.
 *
 * #1533 — and the same pin the driver's merge passes. A recovery command
 * without it is a route past the rule the step enforces: the operator
 * following the handoff would merge whatever head the forge holds at the
 * moment they run it, which is the defect the pin exists to remove. When the
 * step never verified a head the command carries a `<verified-head>`
 * placeholder rather than nothing, so the printed form cannot quietly be an
 * unpinned merge.
 *
 * Forge-aware: `glab mr merge` on GitLab, `gh pr merge` on GitHub.
 */

import { prMergeHeadPinFlag, prMergeSubjectFlag } from "./forge-commands.ts";
import type { ForgeType } from "./forge-detect.ts";
import { isFullCommitSha } from "./review-head-sha.ts";
import type { RecoveryStep } from "./work-driver-handoff-recovery.ts";

/**
 * The pin an operator's recovery command carries: the verified head when the
 * step had one, and a `<verified-head>` placeholder when it did not — the
 * placeholder is the honest rendering of "this command is not runnable as
 * printed until you fill in the commit the review covered", and an absent flag
 * would be the lie that the command is complete.
 */
export function handoffMergePinFlag(forge: ForgeType, headOid: string | undefined): string {
  if (!headOid || !isFullCommitSha(headOid)) {
    return forge === "github" ? " --match-head-commit <verified-head>" : " --sha <verified-head>";
  }
  return prMergeHeadPinFlag(forge, headOid);
}

export function consolidatedMergeStep(
  forge: ForgeType,
  prNumber: number | undefined,
  subject: string | undefined,
  // #1533 — the head the merged step verified, from `pipelineState.mergeHold`.
  headOid?: string,
): RecoveryStep {
  return {
    section: "worktree-work-consolidated",
    comment: [
      "3. Or merge it (the driver's own merge step passes the same explicit subject and the same head pin):",
    ],
    lines: [
      forge === "gitlab"
        ? `glab mr merge ${prNumber ?? "<n>"} --squash${prMergeSubjectFlag(subject)}${handoffMergePinFlag("gitlab", headOid)}`
        : `gh pr merge ${prNumber ?? "<pr>"} --squash${prMergeSubjectFlag(subject)}${handoffMergePinFlag("github", headOid)}`,
    ],
  };
}
