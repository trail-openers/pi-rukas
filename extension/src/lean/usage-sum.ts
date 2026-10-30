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
 * Mirrors `usageOf` in `headless/result.ts`, including the load-bearing rule
 * there: **a dispatch counts whether or not the child succeeded.** A child the
 * budget stopped or the provider killed spent its tokens before it died, and a
 * sum that skipped it would report a failed run as a cheap one — the exact
 * comparison a host cannot afford to get wrong. The difference is only where
 * the rows come from: the driver reads `dispatch-completed`/`dispatch-failed`
 * events, lean reads the step log.
 *
 * Leaf module: it imports types only, so anything — the future schema-5 result,
 * a report, a test — can fold the log without pulling a step in.
 */

import type { DispatchUsage } from "../types.ts";
import type { Step } from "./state.ts";

/** One row of the fold: totals over dispatches, and the counts that produced them. */
export type LeanUsageTotals = DispatchUsage & { dispatches: number };

/** The fold's answer: the run's totals, and the same sums per dispatch role. */
export interface LeanUsage {
  total: LeanUsageTotals;
  byRole: Record<string, LeanUsageTotals>;
}

function zeroUsage(): LeanUsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, dispatches: 0 };
}

/**
 * Add one dispatch to a totals row.
 *
 * `dispatches` increments BEFORE the usage guard and regardless of it: the
 * count is "how many children this run paid for", which a missing usage report
 * does not undo. The fields added afterwards are all numbers by the validator's
 * contract (`outcomeProblem` refuses a row whose usage is absent, infinite or
 * negative), so the sum is an arithmetic fact rather than a `NaN` waiting in a
 * host's document.
 */
function addUsage(t: LeanUsageTotals, u: DispatchUsage | undefined): void {
  t.dispatches++;
  if (u === undefined) return;
  t.input += u.input;
  t.output += u.output;
  t.cacheRead += u.cacheRead;
  t.cacheWrite += u.cacheWrite;
  t.cost += u.cost;
  t.turns += u.turns;
}

/**
 * Fold every dispatch the step log records into totals, in total and per role.
 *
 * Failed dispatches are counted: a row is attached by the step whether the
 * child finished, was stopped by its budget, or died, so skipping `ok: false`
 * here would silently discount the most expensive failures a run has.
 */
export function leanUsage(steps: Step[]): LeanUsage {
  const total: LeanUsageTotals = zeroUsage();
  // A null-prototype map: a child whose role reported `__proto__` is still a
  // child somebody paid for, and on a normal object literal the assignment to
  // that key changes the prototype instead of setting a property, so the row is
  // silently lost from `byRole` while `total` keeps counting it — the two
  // halves of one report disagreeing about the cost of the same dispatch.
  const byRole: Record<string, LeanUsageTotals> = Object.create(null);
  for (const step of steps) {
    for (const row of step.outcome?.dispatches ?? []) {
      addUsage(total, row.usage);
      const role = byRole[row.role] ?? zeroUsage();
      byRole[row.role] = role;
      addUsage(role, row.usage);
    }
  }
  return { total, byRole };
}
