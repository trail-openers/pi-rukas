/**
 * work-driver-cycle-total — per-cycle token roll-up from the driver event log.
 *
 * Issue #534: per-dispatch usage exists (DispatchUsage), but nothing
 * aggregated it to the cycle. This helper is the ONE place a cycle total
 * is computed; the three terminal surfaces (the terminal scrollback line,
 * renderHandoffMarkdown's header, renderTerminalStatus) all render through
 * it so they cannot disagree.
 *
 * The total is the RAW SUM of `usage` across every dispatch-completed AND
 * dispatch-failed* event in the log. Retries appear as separate rows and
 * are summed as-is — deduplication would undercount a cycle whose first
 * attempt genuinely spent tokens before dying. A failed dispatch's spend
 * counts too: a killed child's flushed usage is already summed by
 * collapseEvents (spawn.ts), so its dispatch-failed* event carries it.
 * Events without a usage field (mechanized steps, hard-throw failures
 * where no DispatchResult exists) simply contribute nothing.
 */

import type { WorkEvent } from "./workflow-state-events.ts";

/** Token fields summed per dispatch, matching async-jobs-report.ts totalTokens. */
type UsageShape = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

/** Sum of all four token fields of one dispatch's usage; 0 when absent. */
export function dispatchTokens(e: WorkEvent): number {
  const u = (e as { usage?: UsageShape }).usage;
  if (!u) return 0;
  return (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
}

/**
 * Raw token total for the whole cycle: every dispatch-completed and
 * dispatch-failed* event's usage, summed as-is. 0 when no event carries
 * usage (older state files, pre-#534 cycles) — callers render nothing
 * for 0, which is how pre-#534 files stay byte-identical.
 */
export function cycleTotalTokens(events: readonly WorkEvent[]): number {
  let total = 0;
  for (const e of events) {
    const counted =
      e.kind === "dispatch-completed" ||
      e.kind === "dispatch-failed" ||
      e.kind === "dispatch-failed-provider";
    if (!counted) continue;
    total += dispatchTokens(e);
  }
  return total;
}

/**
 * One-line, human-readable cycle total ("· 412.3k tokens"), or "" when the
 * cycle spent nothing reportable. Compact to 1 decimal, like the per-step
 * column — the total spans the whole cycle and can be in the millions.
 */
export function formatCycleTotal(events: readonly WorkEvent[]): string {
  const total = cycleTotalTokens(events);
  if (!total || total <= 0) return "";
  if (total < 1000) return ` · ${total} tokens`;
  if (total < 10_000) return ` · ${(total / 1000).toFixed(1)}k tokens`;
  if (total < 1_000_000) return ` · ${Math.round(total / 1000)}k tokens`;
  return ` · ${(total / 1_000_000).toFixed(1)}M tokens`;
}
