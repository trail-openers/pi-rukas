/**
 * lean/state-outcome — the per-child cost row, and the rules that let one into a
 * durable record.
 *
 * Split from `state-outcome.ts`, which had grown past the size cap, along the one
 * seam in that file with no dependency on the rest of it: these are the validators
 * for a single `dispatches` row. They read `DispatchUsageRow`'s shape and nothing
 * else, so they can be read — and reasoned about — without the outcome fold that
 * calls them. `state-outcome.ts` keeps `DISPATCH_STATES`, the ownership table, and
 * `outcomeProblem`; this file keeps what a row must look like.
 *
 * What a row is: one child the step paid for. `usage.byRole` in the headless
 * result is the sum of these, so a row that cannot be attributed to a role, a
 * negative cost, or an `ok` that is not a boolean each quietly corrupts a
 * comparison the whole per-role study between the two engines rests on.
 */

import type { DispatchUsageRow } from "./step-budget.ts";

const USAGE_COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "turns"] as const;

/**
 * How many dispatch rows one step may record. Exported because `specify` folds
 * two attempts into ONE outcome and clips its merge here rather than keeping a
 * second copy of the bound the validator enforces.
 */
export const DISPATCHES_MAX_ROWS = 16;

/** Is this a duration a child can honestly report? Finite and never negative. */
export function isMeasure(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The ONE grammar of a fixer row's `runId`, and the only fix-run-id regex in the
 * product source. Exported because a second copy is what broke this field: the
 * reader in `review-log.ts` carried its own permissive literal while this validator
 * carried a digits-only one, and since `validatedDispatches` `continue`s past a row
 * it refuses rather than rejecting the array, the disagreement silently DELETED the
 * fixer row from every review that fixed anything — under-billing the step's most
 * expensive child in `usage.byRole` — while `assertRun` THREW on the same value on
 * any path that persisted a raw row. A rule two files state is a rule one of them
 * will violate.
 *
 * The shape: the epoch milliseconds `fixRunId` mints, then `-<arm>-<round>-<attempt>`
 * for the fix-tree creation that made this tree (`fixRound` mints the composite).
 * No sign, no fraction, no exponent. `Number.isNaN` is not the risk this guards — a
 * hand-edited record or a replayed child result carries `"1e12"`, `"-5"` and `"1.5"`
 * all of which `Number()` would accept and no tree name ever has.
 *
 * **Why the letters are admitted rather than the writer narrowed.** The suffix is
 * what keeps the two arms of one round apart: `fixTreeName` is
 * `lean-<issue>-fix-<arm>-<round>-<attempt>-<epoch>`, and a review round dispatches a
 * fixer on BOTH arms (the adversarial gate's pass-with-findings, and the six-lens
 * round's findings) at the SAME round and the SAME epoch, so a digits-only suffix
 * cannot separate them — and `worktree add --force` ADOPTS a live tree at a path it
 * is handed rather than refusing, which is the collision this suffix exists to close.
 * Narrowing the writer to digits would have traded a billing bug for a correctness
 * one. What the suffix must NOT be is a second free-floating grammar:
 * `[0-9a-z-]{1,24}` admits exactly the suffix form the writer produces (two
 * lowercase arm letters, two decimal counters) plus a bounded total length, and
 * refuses the shapes `Number()` would happily accept.
 */
export const FIX_RUN_ID = /^[0-9]{13,17}(-[0-9a-z-]{1,24})?$/;

/** Is this a fixer row's tree identity, in the shape `fixRunId` mints?
 *
 * Exported because the READER of the same field must ask the same question. It
 * used to carry its own `Number.isSafeInteger(Number(...))` plus a floor check,
 * which accepted what this validator refuses — so the comment in `review-log.ts`
 * claiming the validator had already checked the field was false, and three
 * reviewers called it. One predicate, owned by the module that owns the grammar.
 */
export function isRunId(value: unknown): boolean {
  return typeof value === "string" && FIX_RUN_ID.test(value);
}

/** Is this value a usage row of the shape `DispatchUsage` describes? */
function isUsageRow(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  // A count of tokens is never a fraction and never infinite: `1e400` arrives
  // from JSON as `Infinity`, and an infinite total printed to a host is a
  // record that reads as evidence and compares against nothing.
  if (!["input", "output", "cacheRead", "cacheWrite", "turns"].every((k) => isCount(u[k])))
    return false;
  // `cost` is the one field that is NOT an integer count: `addUsage` in
  // `pi-usage.ts` accumulates a currency total, so a real report carries
  // fractions (0.00000625 for one small child) and refusing them would refuse
  // every honest row. It is still a finite non-negative number — a negative
  // cost would SUBTRACT from a host's total and an infinite one cannot print.
  return isMeasure(u.cost);
}

/** Is this an integer count a child reported: a non-negative safe integer? */
function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Why a `dispatches` array is not a cost record this run may report, or undefined.
 *
 * Each row is one child the step paid for, and the headless result sums these
 * into `usage.byRole`. A row with no role cannot be attributed to a role, a
 * negative cost would subtract from the total, and a row whose `ok` is not a
 * boolean leaves the reader unable to tell a stopped child from a finished one
 * — which is the distinction the whole per-role comparison between engines rests on.
 */
export function dispatchesProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return "outcome dispatches must be an array";
  if (value.length > DISPATCHES_MAX_ROWS)
    return `outcome dispatches must hold at most ${DISPATCHES_MAX_ROWS} rows`;
  for (const [i, raw] of value.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return `outcome dispatches[${String(i)}] must be an object`;
    const row = raw as Record<string, unknown>;
    if (typeof row.role !== "string" || row.role === "")
      return `outcome dispatches[${String(i)}].role must be a non-empty string`;
    if (typeof row.ok !== "boolean") return `outcome dispatches[${String(i)}].ok must be a boolean`;
    if (!isMeasure(row.ms))
      return `outcome dispatches[${String(i)}].ms must be a finite number >= 0`;
    if (!isUsageRow(row.usage))
      return `outcome dispatches[${String(i)}].usage must carry non-negative integer input, output, cacheRead, cacheWrite, cost and turns`;
    // `runId` is optional, but when present it must be the shape `fixRunId`
    // mints: the reader that puts a resumed attempt back onto the tree its
    // crashed self left matches on this field, and a value that is merely
    // *present* would name a directory the step then treats as its own.
    if (row.runId !== undefined && !isRunId(row.runId))
      return `outcome dispatches[${String(i)}].runId must be a decimal epoch-millisecond string`;
  }
  return undefined;
}

/** The `dispatches` rows, rebuilt from the ones this module actually checked. */
export function validatedDispatches(value: unknown): DispatchUsageRow[] {
  const out: DispatchUsageRow[] = [];
  if (!Array.isArray(value)) return out;
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (typeof row.role !== "string" || row.role === "") continue;
    if (typeof row.ok !== "boolean" || !isMeasure(row.ms) || !isUsageRow(row.usage)) continue;
    if (row.runId !== undefined && !isRunId(row.runId)) continue;
    const u = row.usage as Record<string, unknown>;
    // Each count is RE-DERIVED from the check rather than cast: `isUsageRow`
    // already proved all six are non-negative safe integers, and reading them
    // back through `unknown` keeps the rebuilt row a product of the validation.
    const count = (k: (typeof USAGE_COUNTERS)[number] | "cost"): number => u[k] as number;
    out.push({
      role: row.role,
      ms: row.ms as number,
      ok: row.ok as boolean,
      usage: {
        input: count("input"),
        output: count("output"),
        cacheRead: count("cacheRead"),
        cacheWrite: count("cacheWrite"),
        cost: count("cost"),
        turns: count("turns"),
      },
      ...(row.runId === undefined ? {} : { runId: row.runId as DispatchUsageRow["runId"] }),
    });
  }
  return out;
}
