/**
 * The fake child's quiet tick, for the build fixture's dispatch (#2644). A case says only
 * HOW LONG its child has been quiet; this stands where the spawn's stream stamp would, then
 * calls the arm's OWN progress hook, so the step's lever measures the silence, decides
 * against the window it derived and fires its own abort. A tool call in flight is work
 * rather than silence and is never a stall (#951).
 */

import type { BudgetOpts } from "../../src/lean/step-budget.ts";
import type { DispatchResult } from "../../src/types.ts";

export interface QuietTickOpts {
  /** The case's measured silence, ms; a function so a case can vary it per dispatch. */
  silentMs?: number | (() => number);
  /** The child's declared tool calls; non-empty means work in flight, not silence. */
  toolUses?: unknown[] | (() => unknown[]);
}

/** Whether this child's stream was quiet past the armed window, and the abort it produced. */
export function deliverQuietTick(
  role: DispatchResult["role"],
  o: { stall?: BudgetOpts["stall"]; onProgress?: BudgetOpts["onProgress"] },
  opts: QuietTickOpts,
): void {
  if (o.stall === undefined || o.onProgress === undefined) return;
  const declared = typeof opts.toolUses === "function" ? opts.toolUses() : (opts.toolUses ?? []);
  const silent = typeof opts.silentMs === "function" ? opts.silentMs() : opts.silentMs ?? 0;
  // The reader stands where the spawn's own stamp would, on the arm's live opts object.
  o.stall.silence = () => ({ sinceMs: silent, toolInFlight: declared.length > 0 });
  o.onProgress({
    role,
    turns: 0,
    toolUses: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    totalTokens: 0,
    elapsedMs: silent,
    done: false,
  });
}
