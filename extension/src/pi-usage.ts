/**
 * #1032 — shared usage accumulation, one implementation for the two paths
 * that must agree (the live ingest path and the collapseEvents replay path):
 * add `u` to the running totals `acc`, plus `tokens = input + output +
 * cacheRead + cacheWrite` for the cumulative token budget. Both paths sum
 * assistant usage and toolResult usage (the #1032 nested-codemode spend)
 * through this, exactly once each.
 */

import type { PiUsage } from "./pi-event-shapes.ts";
import type { DispatchUsage } from "./types.ts";

export function addUsage(
  acc: Omit<DispatchUsage, "turns">,
  u: PiUsage,
  tokens: { totalTokens?: number },
): number {
  acc.input += u.input ?? 0;
  acc.output += u.output ?? 0;
  acc.cacheRead += u.cacheRead ?? 0;
  acc.cacheWrite += u.cacheWrite ?? 0;
  acc.cost += u.cost?.total ?? 0;
  // #543 F6 — running cumulative total, the token-budget quantity.
  const added = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  if (tokens.totalTokens !== undefined) tokens.totalTokens += added;
  return added;
}
