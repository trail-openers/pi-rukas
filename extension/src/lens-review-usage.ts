import type { LensRunResult } from "./lens-review.ts";
import type { DispatchUsage } from "./types.ts";

/**
 * #534 — raw sum across lenses (no dedup, matching the retry rule).
 * `turns` is not meaningful at the aggregate level; keep it as the sum
 * of the parts' turns since the cycle total is what gets rendered and
 * no consumer interprets the aggregate's turn count.
 */
export function aggregateLensUsage(lensResults: LensRunResult[]): DispatchUsage | undefined {
  const usageUsages = lensResults
    .map((r) => r.usage)
    .filter((u): u is DispatchUsage => u !== undefined);
  if (usageUsages.length === 0) return undefined;
  return usageUsages.reduce(
    (acc, u) => ({
      input: acc.input + u.input,
      output: acc.output + u.output,
      cacheRead: acc.cacheRead + u.cacheRead,
      cacheWrite: acc.cacheWrite + u.cacheWrite,
      cost: acc.cost + u.cost,
      turns: acc.turns + u.turns,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  );
}
