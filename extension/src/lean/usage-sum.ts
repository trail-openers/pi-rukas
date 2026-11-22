/**
 * lean/usage-sum — what a lean run's children cost, in total and per role.
 *
 * The lean step log records one row per dispatch on the three dispatching steps (`Outcome.dispatches`, owned
 * by `specify`/`build`/`challenge`). This folds those rows: `total` and one row per `role`, the same shape the
 * headless `work` result reports as `usage`/`usage.byRole`, so a host comparing the two engines reads one shape
 * and one definition of "cost".
 *
 * The fold is not restated here: it is `foldUsage` in `../usage-fold.ts`. **A dispatch counts whether or not
 * the child succeeded** — a child the budget stopped or the provider killed spent its tokens before it died,
 * and a sum that skipped it would report a failed run as a cheap one.
 *
 * Leaf module: it imports types only, so anything can fold the log without pulling a step in.
 */

import type { DispatchUsage } from "../types.ts";
import type { UsageFold } from "../usage-fold.ts";
import { foldUsage } from "../usage-fold.ts";
import type { Step } from "./state.ts";

/** One row of the fold: totals over dispatches, and the counts that produced them. */
export type { UsageTotals as LeanUsageTotals } from "../usage-fold.ts";

/** The fold's answer: the run's totals, and the same sums per dispatch role. */
type LeanUsage = UsageFold;

/**
 * Fold every dispatch the step log records into totals, in total and per role.
 *
 * Failed dispatches are counted: a row is attached by the step whether the child finished, was stopped by its
 * budget, or died. That counting, the null-prototype `byRole` and the zero row all come from the shared fold.
 *
 * The row's `usage` is COPIED out rather than handed over whole: `DispatchUsageRow` is not assignable to the
 * fold's `{role, usage}`. The numbers are read field by field so the copy is the record the loader validated.
 */
export function leanUsage(steps: Step[]): LeanUsage {
  const rows: { role: string; usage: DispatchUsage | undefined }[] = [];
  for (const step of steps) {
    for (const row of step.outcome?.dispatches ?? []) {
      const u: DispatchUsage | undefined =
        row.usage === undefined
          ? undefined
          : {
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
