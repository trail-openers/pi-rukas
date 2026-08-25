/**
 * #500 — the commit-pr handoff's two cap-gated sections: the ops-fallback
 * plumb-report's hedge (an event-log entry nothing pre-#500 rendered — the
 * DoD "the hedge is rendered into the handoff body") and the recorded
 * repoRoot facts (the single source `commitPrRootFactLines` the in-chat
 * twin uses, so the two surfaces cannot drift). Both render only for the
 * three commit-pr caps — the "wrong commands for the cap" class #398's
 * rewrites eliminated. Split from work-driver-handoff-markdown.ts for
 * file-size hygiene.
 */

import { commitPrRootFactLines } from "./work-driver-commit-inspect.ts";
import type { CommitPrRootState } from "./workflow-state-schema.ts";
import type { WorkEvent, WorkState } from "./workflow-state.ts";

const COMMIT_PR_CAPS = [
  "commit-pr-incomplete-consolidation",
  "verify-failed:commit-pr",
  "integration-verify-failed",
] as const;

function isCommitPrCap(cap: string | undefined): boolean {
  return cap !== undefined && (COMMIT_PR_CAPS as readonly string[]).includes(cap);
}

export function commitPrFallbackPlumbSection(state: WorkState, cap: string | undefined): string[] {
  if (!isCommitPrCap(cap)) return [];
  const report = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "plumb-report" }> =>
        e.kind === "plumb-report" && e.step === "commit-pr",
    );
  if (!report) return [];
  return ["### commit-pr fallback note", "", `> ${report.body}`, ""];
}

export function commitPrRootFacts(state: WorkState, cap: string | undefined): string[] {
  if (!isCommitPrCap(cap)) return [];
  const facts = commitPrRootFactLines(
    state.pipelineState.commitPrRoot,
    state.pipelineState.commitPrRootError,
    "",
    "",
  );
  if (facts.length === 0) return [];
  return ["### repoRoot state at commit-pr handoff", "", ...facts, ""];
}

/**
 * #539 review — the sweep-safe "# 0" recovery step for the commit-pr handoff:
 * when the recorded tree is NOT clean, the operator must run `git status`
 * first and commit ONLY the applied patch paths. The two handoff surfaces
 * (markdown + in-chat) previously each derived their own `dirtyUntracked`
 * predicate and carried a verbatim copy of the block — the "agree by copy"
 * drift class this project keeps paying for. Single source now; each surface
 * only supplies its command-prefix/indent style.
 *
 * The predicate is the RECORDED state (`commitPrRoot`), not a re-parse of
 * the plumb-report's `fallbackCause`: the cause names WHY the mechanized
 * path fell back (pre-fallback state), while the recorded state is what
 * repoRoot actually held AFTER — and for a dirty-repoRoot fallback the two
 * differ (the refusal left the dirty residue untouched). `commitPrRoot` is
 * written by both the mechanized path and the ops-fallback path, so it
 * covers both.
 */
export function commitPrDirtyRootStep(
  root: CommitPrRootState | undefined,
  commentPrefix: string,
  cmdPrefix: string,
): string[] {
  if (!root) return [];
  const untracked = root.totalEntries - root.stagedCount - root.unmergedPaths.length;
  if (untracked <= 0 || root.unmergedPaths.length > 0) return [];
  return [
    `${commentPrefix}# 0. The tree is NOT clean — it holds untracked residue from a prior cycle (or a sibling's in-flight work). Run git status first; commit ONLY the applied patch paths; never bare \`git commit\` after \`add -A\`. The dirty paths may belong to another cycle; check .pi/work-state/ before discarding.`,
    `${cmdPrefix}git status`,
    "",
  ];
}
