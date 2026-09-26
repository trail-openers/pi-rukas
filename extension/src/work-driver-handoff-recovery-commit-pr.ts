/**
 * work-driver-handoff-recovery-commit-pr — the commit-pr consolidation
 * recovery recipe, moved verbatim from work-driver-handoff-recovery-caps.ts
 * for the 500-line cap (#861).
 */

import { cherryPickRecoveryFor } from "./work-driver-handoff-cherry-pick.ts";
import { CONSOLIDATE_APPLY, type RecoveryStep } from "./work-driver-handoff-recovery.ts";
import { missingWorkstreamsFromConsolidation } from "./workflow-state.ts";
import type { WorkState } from "./workflow-state.ts";

function commitPrConsolidationSteps(state: WorkState, issue: number): RecoveryStep[] {
  const ps = state.pipelineState;
  const missing = missingWorkstreamsFromConsolidation(ps.incompleteConsolidation);
  const ic = ps.incompleteConsolidation;
  const isDirty = (id: string): boolean => {
    if (ic === undefined || Array.isArray(ic)) return true;
    const v = ic.verdicts.find((x) => x.id === id);
    return !v || v.status !== "uncovered" || v.dirty !== false;
  };
  const dirtyMissing = missing.filter((m) => isDirty(m.id));
  const cleanMissing = missing.filter((m) => !isDirty(m.id));
  const S = "commit-pr-incomplete-consolidation" as const;
  const steps: RecoveryStep[] = [
    {
      section: S,
      comment: ["1. Inspect each missing workstream's worktree:"],
      lines: missing.map((m) => `git -C .worktrees/issue-${issue}-${m.id} status --porcelain`),
    },
  ];
  if (dirtyMissing.length > 0) {
    steps.push({
      section: S,
      comment: ["2. Apply each missing diff (stage first — `diff HEAD` omits untracked):"],
      lines: dirtyMissing.flatMap((m) => [
        `git -C .worktrees/issue-${issue}-${m.id} add -A`,
        `git -C .worktrees/issue-${issue}-${m.id} diff --cached --binary | ${CONSOLIDATE_APPLY}    # in the integration tree`,
      ]),
    });
  }
  if (cleanMissing.length > 0) {
    steps.push({
      section: S,
      comment: [
        "2b. Cherry-pick each committed (dirty=false) workstream's work onto the",
        "    integration branch — the work is already committed in the worktree:",
      ],
      lines: cleanMissing.map(
        (m) =>
          cherryPickRecoveryFor(issue, m.id, {
            worktree: ps.worktrees?.[m.id],
            baseSha: ps.baseSha,
            ownBase: ps.workstreamBaseShas?.[m.id],
            headSha: ps.commitShas?.[m.id],
            comment: `workstream: ${m.id} — if it genuinely needed a change, cherry-pick; otherwise the declaration was over-broad and the fix is a restart`,
          }).line,
      ),
    });
  }
  steps.push(
    {
      section: S,
      comment: ["3. Verify all workstreams' files now appear, then commit + push:"],
      lines: ["git diff --name-only --cached", "git commit -m '<concise>'", "git push"],
    },
    {
      section: S,
      comment: ["4. Or: abandon + restart from scratch:"],
      lines: [`rm .pi/work-state/${issue}.json`, `/work ${issue} --restart`],
    },
  );
  return steps;
}

export { commitPrConsolidationSteps };
