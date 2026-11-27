/**
 * lean/usage-sum — what a lean run's children cost, in total and per role.
 *
 * The lean step log records one row per dispatch on the three dispatching steps (`Outcome.dispatches`, owned
 * by `specify`/`build`/`challenge`). This folds those rows: `total` and one row per `role`, the same shape the
 * headless `work` result reports as `usage`/`usage.byRole`, so a host comparing the two engines reads one shape
 * and one definition of "cost".
 *
 * The fold is not restated here: it is `foldUsage` in `../usage-fold.ts`. **A dispatch counts whether or not
 * the child succeeded** — a child the budget stopped or the provider killed spent its tokens before it died.
 *
 * Leaf module: it imports types only, so anything can fold the log without pulling a step in.
 */

import type { DispatchUsage } from "../types.ts";
import type { UsageFold } from "../usage-fold.ts";
import { foldUsage } from "../usage-fold.ts";
import type { Step } from "./state.ts";

/**
 * Fold every dispatch the step log records into totals, in total and per role. The row's `usage` is
 * COPIED out, field by field, rather than handed over whole: only the numbers the loader validated
 * reach the fold.
 */
export function leanUsage(steps: Step[]): UsageFold {
  const rows: { role: string; usage: DispatchUsage | undefined }[] = [];
  for (const step of steps) {
    for (const row of step.outcome?.dispatches ?? []) {
      const u: DispatchUsage | undefined = row.usage && {
        input: row.usage.input,
        output: row.usage.output,
        cacheRead: row.usage.cacheRead,
        cacheWrite: row.usage.cacheWrite,
        cost: row.usage.cost,
        costFromProvider: row.usage.costFromProvider,
        turns: row.usage.turns,
        toolCalls: row.usage.toolCalls,
        toolErrors: row.usage.toolErrors,
      };
      rows.push({ role: row.role, usage: u });
    }
  }
  return foldUsage(rows);
}
