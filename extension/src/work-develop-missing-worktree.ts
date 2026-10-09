/**
 * work-develop-missing-worktree — #746: refuse the develop dispatch of an
 * independent workstream that has no worktree entry.
 *
 * Extracted from work-develop-topological.ts (500-line gate). A missing
 * worktree is failed with a named error rather than falling back to repoRoot,
 * so the developer never runs in the Pi process directory.
 */
import { trace } from "./trace.ts";
import type { WorkEvent } from "./workflow-state.ts";

export function refuseMissingWorktrees(args: {
  missing: string[];
  multi: boolean;
  branchEvents: WorkEvent[];
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>;
  failedOrSkipped: Set<string>;
  failureSource: Record<string, "skipped" | "failed">;
}): void {
  const { missing, multi, branchEvents, verdicts, failedOrSkipped, failureSource } = args;
  for (const id of missing) {
    const err = `no worktree recorded for workstream ${id} (worktrees map has no entry) — dispatch refused rather than falling back to repoRoot`;
    branchEvents.push({
      kind: "dispatch-failed",
      step: "develop",
      role: "developer",
      jobId: "unknown",
      label: multi ? `developer[${id}]` : "developer",
      ms: 0,
      at: Date.now(),
      errorTail: err.slice(0, 200),
    });
    branchEvents.push({
      kind: "branch-completed",
      step: "develop",
      workstreamId: id,
      ok: false,
      ms: 0,
      at: Date.now(),
      error: err,
    });
    verdicts.push({ id, ok: false });
    failedOrSkipped.add(id);
    if (failureSource[id] === undefined) failureSource[id] = "failed";
    trace(`work-driver: develop refused for ${id} — ${err}`);
  }
}
