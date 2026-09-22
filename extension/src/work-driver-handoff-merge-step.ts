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
 * Forge-aware: `glab mr merge` on GitLab, `gh pr merge` on GitHub.
 */

import { prMergeSubjectFlag } from "./forge-commands.ts";
import type { ForgeType } from "./forge-detect.ts";
import type { RecoveryStep } from "./work-driver-handoff-recovery.ts";

export function consolidatedMergeStep(
  forge: ForgeType,
  prNumber: number | undefined,
  subject: string | undefined,
): RecoveryStep {
  return {
    section: "worktree-work-consolidated",
    comment: ["3. Or merge it (the driver's own merge step passes the same explicit subject):"],
    lines: [
      forge === "gitlab"
        ? `glab mr merge ${prNumber ?? "<n>"} --squash${prMergeSubjectFlag(subject)}`
        : `gh pr merge ${prNumber ?? "<pr>"} --squash${prMergeSubjectFlag(subject)}`,
    ],
  };
}
