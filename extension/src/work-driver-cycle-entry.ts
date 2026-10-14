/**
 * work-driver-cycle-entry — the bookkeeping a /work cycle does before its first
 * step. Split out of work-driver.ts (AGENTS.md §12 500-line cap).
 *
 * `enterCycle` binds the host's `emit` seam to this cycle's state file (S4a,
 * #1162), so `writeState` emits each eventLog entry through the host. It
 * returns the unbind function the driver calls when the cycle ends.
 */

import { dropSlowEvents } from "./slow-events.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { bindStateEmitter } from "./work-state-emit.ts";
import { workStateFile } from "./workflow-state.ts";

export function enterCycle(ctx: DriverContext): () => void {
  // #799 — clear any stale slow-event buffer entry for EVERY issue in the
  // group before the cycle begins: a previous parked cycle of the same
  // issue (whose handoff's final drain ran before a late crossing) can
  // otherwise leak its leftover events into this cycle's log.
  const groupIssues = [...new Set([ctx.issue, ...(ctx.issues ?? [])])];
  for (const n of groupIssues) dropSlowEvents(n);
  return bindStateEmitter(workStateFile(ctx.repoRoot, ctx.issue), (e) => ctx.host.emit?.(e));
}
