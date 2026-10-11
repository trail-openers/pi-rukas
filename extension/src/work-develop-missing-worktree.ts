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
  /** Per-id refusal reason; ids not listed get the missing-worktree message. */
  reasons?: Record<string, string>;
  multi: boolean;
  branchEvents: WorkEvent[];
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>;
  failedOrSkipped: Set<string>;
  failureSource: Record<string, "skipped" | "failed">;
}): void {
  const { missing, reasons, multi, branchEvents, verdicts, failedOrSkipped, failureSource } = args;
  for (const id of missing) {
    const err =
      reasons?.[id] ??
      `no worktree recorded for workstream ${id} (worktrees map has no entry) — dispatch refused rather than falling back to repoRoot`;
    branchEvents.push({
      kind: "branch-completed",
      step: "develop",
      workstreamId: id,
      ok: false,
      ms: 0,
      at: Date.now(),
      error: err,
    });
    // dispatch-failed comes LAST: for N=1 it is the event the step router reads
    // as the failure (a trailing branch-completed would route past the refusal).
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
    verdicts.push({ id, ok: false });
    failedOrSkipped.add(id);
    if (failureSource[id] === undefined) failureSource[id] = "failed";
    trace(`work-driver: develop refused for ${id} — ${err}`);
  }
}
