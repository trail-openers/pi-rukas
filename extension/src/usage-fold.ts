/**
 * usage-fold — the ONE fold over dispatch rows, shared by the headless `work`
 * result (`headless/result.ts`'s `usageOf`) and the lean run's cost report
 * (`lean/usage-sum.ts`'s `leanUsage`) (#1920 slice B).
 *
 * Both readers sum the same numbers over rows that come from different places
 * — the driver reads `dispatch-completed`/`dispatch-failed` events off a
 * `WorkState`, lean reads `Outcome.dispatches` rows off a step log — and a host
 * that compares cost between the two engines is comparing two halves of ONE
 * definition. Two folds is two definitions: the day one of them counts a failed
 * child and the other does not, the cheaper-looking engine is the one that lied.
 *
 * So the shape, the zero value, the add operation and the per-role fold live
 * here and nowhere else. The input is the minimum both readers can produce:
 * rows of `{role, usage}`, from which the fold returns `{total, byRole}`.
 *
 * The load-bearing rule, restated from where it was first written: **a dispatch
 * counts whether or not the child succeeded.** A child the budget stopped or the
 * provider killed spent its tokens before it died, and a sum that skipped it
 * would report a failed run as a cheap one — the exact comparison a host cannot
 * afford to get wrong.
 *
 * Leaf module: it imports a type only, so anything — the driver, the lean
 * result, a report, a test — can fold a log without pulling in a step or a
 * state file.
 */

import type { DispatchUsage } from "./types.ts";

/** One row of the fold: totals over dispatches, and the count that produced them. */
export type UsageTotals = DispatchUsage & { dispatches: number };

/** The fold's answer: the totals, and the same sums per dispatch `role`. */
export interface UsageFold {
  total: UsageTotals;
  byRole: Record<string, UsageTotals>;
}

/** One thing a caller has already paid for, in the only shape this fold reads. */
export interface UsageRow {
  role: string;
  usage: DispatchUsage | undefined;
}

/**
 * The per-role map on a NULL PROTOTYPE, built the one way that keeps the
 * prototype null.
 *
 * `{ ...Object.create(null) }` does NOT: the spread reads the source through
 * `ownKeys`/`getOwnPropertyDescriptor` and writes the properties onto a NEW
 * ordinary `{}`, prototype and all — so a `{ ...Object.create(null) }` literal
 * is a plain object wearing a null prototype's costume, and a role named
 * `__proto__` would once again be assigned to a normal object and lost from the
 * map. The construction is a helper so the rule is stated once and cannot be
 * re-derived wrong at a call site.
 */
export function createTotalsMap(): Record<string, UsageTotals> {
  return Object.create(null) as Record<string, UsageTotals>;
}

/** The zero row. Fresh per call — a shared zero would be a shared accumulator. */
export function zeroUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, dispatches: 0 };
}

/**
 * Add one dispatch to a totals row.
 *
 * `dispatches` increments BEFORE the usage guard and regardless of it: the
 * count is "how many children this run paid for", which a missing usage report
 * does not undo. The fields added afterwards are numbers by each caller's
 * contract (lean's `outcomeProblem` refuses a row whose usage is absent,
 * infinite or negative; the driver's events carry what Pi reported), so the sum
 * is an arithmetic fact rather than a `NaN` waiting in a host's document.
 */
export function addUsage(t: UsageTotals, u: DispatchUsage | undefined): void {
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
 * Fold rows into totals, in total and per role.
 *
 * `byRole` is built on a NULL PROTOTYPE, which is not a stylistic choice: a
 * child whose role reported `__proto__` is still a child somebody paid for, and
 * on a normal object literal the assignment to that key changes the prototype
 * instead of setting a property. The row would then be silently lost from
 * `byRole` while `total` kept counting it — the two halves of one report
 * disagreeing about the cost of the same dispatch.
 *
 * Rows are pulled apart field by field rather than passed through: a caller's
 * row type may carry more (lean's carries `ms` and `ok`), and this fold adds
 * neither, so what it reads is all it trusts.
 */
export function foldUsage(rows: readonly UsageRow[]): UsageFold {
  const total: UsageTotals = zeroUsage();
  const byRole = createTotalsMap();
  for (const row of rows) {
    addUsage(total, row.usage);
    const role = byRole[row.role] ?? zeroUsage();
    byRole[row.role] = role;
    addUsage(role, row.usage);
  }
  return { total, byRole };
}
