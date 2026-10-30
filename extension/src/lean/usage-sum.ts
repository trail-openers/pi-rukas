/**
 * lean/usage-sum — what a lean run's children cost, in total and per role
 * (#1920 slice A).
 *
 * The lean step log now records one row per dispatch on the three dispatching
 * steps (`Outcome.dispatches`, owned by `specify`/`build`/`challenge`). This
 * folds those rows: `total` and one row per `role`, the same shape the headless
 * `work` result reports as `usage`/`usage.byRole`, so a host comparing the two
 * engines reads one shape and one definition of "cost".
 *
 * Since #1920 slice B the fold is not restated here: it is `foldUsage` in
 * `../usage-fold.ts`, which `usageOf` in `headless/result.ts` calls with the
 * driver's own dispatch events. **A dispatch counts whether or not the child
 * succeeded** — a child the budget stopped or the provider killed spent its
 * tokens before it died, and a sum that skipped it would report a failed run as
 * a cheap one. The rule lives there once, for both readers; the only difference
 * between the two callers is where the rows come from (the driver reads
 * `dispatch-completed`/`dispatch-failed` events, lean reads the step log).
 *
 * Leaf module: it imports types only, so anything — the schema-5 result, a
 * report, a test — can fold the log without pulling a step in.
 */

import type { DispatchUsage } from "../types.ts";
import type { UsageFold } from "../usage-fold.ts";
import { foldUsage } from "../usage-fold.ts";
import type { Step } from "./state.ts";

/** One row of the fold: totals over dispatches, and the counts that produced them. */
export type { UsageTotals as LeanUsageTotals } from "../usage-fold.ts";

/** The fold's answer: the run's totals, and the same sums per dispatch role. */
export type LeanUsage = UsageFold;

/**
 * Fold every dispatch the step log records into totals, in total and per role.
 *
 * Failed dispatches are counted: a row is attached by the step whether the
 * child finished, was stopped by its budget, or died, so skipping `ok: false`
 * here would silently discount the most expensive failures a run has. That
 * counting, the null-prototype `byRole` and the zero row all come from the
 * shared fold — see the module doc for why they cannot be re-derived here.
 *
 * The row's `usage` is COPIED out rather than handed over whole: a step row is
 * `{role, ms, ok, usage}` and `DispatchUsageRow` is not assignable to the fold's
 * `{role, usage}` (the fold accepts a missing `usage`, the validator forbids
 * one), so this module is where the log's shape meets the fold's. The six
 * numbers are read field by field so the copy is the same record the loader
 * validated, not an `as never` over the shape mismatch.
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
              turns: row.usage.turns,
            };
      rows.push({ role: row.role, usage: u });
    }
  }
  return foldUsage(rows);
}
