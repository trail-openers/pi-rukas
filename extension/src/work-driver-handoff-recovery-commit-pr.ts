/**
 * work-driver-handoff-recovery-commit-pr — the commit-pr consolidation
 * recovery recipe, moved verbatim from work-driver-handoff-recovery-caps.ts
 * for the 500-line cap (#861).
 */

import { basename } from "node:path";
import { cherryPickRecoveryFor } from "./work-driver-handoff-cherry-pick.ts";
import { CONSOLIDATE_APPLY, type RecoveryStep } from "./work-driver-handoff-recovery.ts";
import { removedAtHandoff } from "./work-driver-handoff-snapshot.ts";
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
  // A tree the handoff teardown removed is recovered from its stop-salvage ref.
  const gone = (id: string) => removedAtHandoff(ps, ps.worktrees?.[id]);
  const refsOf = (id: string) =>
    (ps.handoffSnapshot?.stopSalvage ?? []).filter((r) =>
      r.includes(`/${basename(ps.worktrees?.[id] ?? "")}/`),
    );
  const live = missing.filter((m) => !gone(m.id));
  const dirtyMissing = live.filter((m) => isDirty(m.id));
  const cleanMissing = live.filter((m) => !isDirty(m.id));
  const salvaged = missing
    .filter((m) => gone(m.id))
    .flatMap((m) => refsOf(m.id).map((r) => [m.id, r] as const));
  const S = "commit-pr-incomplete-consolidation" as const;
  const steps: RecoveryStep[] = [
    {
      section: S,
      comment: ["1. Inspect each missing workstream's worktree, or the ref a removed one left:"],
      lines: missing.flatMap((m) =>
        !gone(m.id)
          ? [`git -C .worktrees/issue-${issue}-${m.id} status --porcelain`]
          : refsOf(m.id).length > 0
            ? refsOf(m.id).map((r) => `git log --oneline ${r} --not --branches`)
            : [`# ${m.id}: its worktree was removed at handoff; a local branch holds its work`],
      ),
    },
  ];
  if (salvaged.length > 0) {
    steps.push({
      section: S,
      comment: ["2a. Apply each removed workstream's salvaged work:"],
      lines: salvaged.map(
        ([id, r]) =>
          `git diff --binary ${ps.workstreamBaseShas?.[id] ?? ps.baseSha ?? "<base>"} ${r} | ${CONSOLIDATE_APPLY}    # in the integration tree`,
      ),
    });
  }
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
