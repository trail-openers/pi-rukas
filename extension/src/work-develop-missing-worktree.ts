/**
 * work-develop-missing-worktree — #746: refuse the develop dispatch of an
 * independent workstream that has no worktree entry.
 *
 * Extracted from work-develop-topological.ts (500-line gate). A missing
 * worktree is failed with a named error rather than falling back to repoRoot,
 * so the developer never runs in the Pi process directory.
 *
 * A refusal is a driver decision, not an infrastructure failure: it records the
 * branch-completed failure ONLY. A `dispatch-failed` event would tell the step
 * router the child failed transiently and invite a backoff retry of a refusal
 * that retrying cannot fix.
 */
import { trace } from "./trace.ts";
import type { WorkEvent } from "./workflow-state.ts";

export function refuseMissingWorktrees(args: {
  missing: string[];
  /** Per-id refusal reason; ids not listed get the missing-worktree message. */
  reasons?: Record<string, string>;
  branchEvents: WorkEvent[];
  verdicts: Array<{ id: string; ok: boolean; reason?: string }>;
  failedOrSkipped: Set<string>;
  failureSource: Record<string, "skipped" | "failed">;
}): void {
  const { missing, reasons, branchEvents, verdicts, failedOrSkipped, failureSource } = args;
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
      refused: true,
    });
    verdicts.push({ id, ok: false, reason: err });
    failedOrSkipped.add(id);
    if (failureSource[id] === undefined) failureSource[id] = "failed";
    trace(`work-driver: develop refused for ${id} — ${err}`);
  }
}
