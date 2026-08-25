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
