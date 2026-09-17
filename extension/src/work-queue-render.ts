/**
 * work-queue-render — the end-of-queue report renderer, extracted from
 * work-queue.ts (AGENTS.md §12 500-line cap). Pure formatter over the
 * `QueueSummary` the queue loop builds: one entry per group (merged /
 * parked / not-started / halted), the parked entry's `failedStep` and
 * `humanAction` on their own lines.
 *
 * `parkReason` and `humanActionFor` stay in work-queue.ts — they are the
 * queue's DECISION logic (which step died, what the operator must do),
 * not rendering; only this text builder moves.
 */

import type { QueueSummary } from "./work-queue.ts";

/** Render the end-of-queue report. One entry per group. */
export function renderQueueSummary(s: QueueSummary): string {
  const lines = [
    `pi-rukas: /work queue finished — ${s.merged} merged, ${s.parked} parked${
      s.refused > 0 ? `, ${s.refused} did not start` : ""
    }${s.notStarted.length > 0 ? `, ${s.notStarted.length} never reached` : ""}`,
  ];
  for (const e of s.entries) {
    const issues = `#${e.issues.join(", #")}`;
    if (e.outcome === "merged") {
      lines.push(`  ✓ ${e.groupId} (${issues}) — merged`);
    } else if (e.outcome === "parked") {
      lines.push(
        `  ⏸ ${e.groupId} (${issues}) — ${e.reason}${e.failedStep ? ` at ${e.failedStep}` : ""}`,
      );
      if (e.humanAction) lines.push(`      → ${e.humanAction}`);
    } else if (e.outcome === "not-started") {
      // Not a failure, emphatically not a halt: the driver declined to run,
      // usually because a live cycle already owns the issue. Rendering it
      // through the `else` below reported a halt that never happened.
      lines.push(`  – ${e.groupId} (${issues}) — did not start: ${e.reason}`);
      if (e.humanAction) lines.push(`      → ${e.humanAction}`);
    } else {
      lines.push(`  ✗ ${e.groupId} (${issues}) — ${e.reason} · queue halted here`);
    }
  }
  if (s.notStarted.length > 0) {
    lines.push(`  Not started: ${s.notStarted.join(", ")}`);
  }
  return lines.join("\n");
}
