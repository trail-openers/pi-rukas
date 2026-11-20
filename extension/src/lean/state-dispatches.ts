/**
 * lean/state-outcome — the per-child cost row, and the rules that let one into a
 * durable record.
 *
 * Split from `state-outcome.ts` along the one seam in that file with no dependency on the rest of it:
 * these are the validators for a single `dispatches` row. They read `DispatchUsageRow`'s shape and
 * nothing else. `state-outcome.ts` keeps `DISPATCH_STATES`, the ownership table, and `outcomeProblem`;
 * this file keeps what a row must look like.
 *
 * What a row is: one child the step paid for. `usage.byRole` in the headless result is the sum of
 * these, so a row that cannot be attributed to a role, a negative cost, or an `ok` that is not a
 * boolean each quietly corrupts the per-role comparison between the two engines.
 */

import { LANES_CAP, MAX_REASON_CHARS } from "./review-bound.ts";
import type { ReviewBoundRecord } from "./review-bound.ts";
import type { DispatchUsageRow } from "./step-budget.ts";

/// The shape one lane or its reason must hold: a value that would print as STRUCTURE in the PR comment
/// or the handback is no disclosure anyone can read — a string, trimmed, printable, within `max`.
/// Exported for the writer of a child-reported row (`fixer-truncation.ts`'s `continuationRow`), which
/// normalises with this test at the row boundary: this module's answer to an unparseable field is to
/// drop the WHOLE row silently (`validatedDispatches` `continue`s), so a writer that left the refusal
/// to the loader would lose the record of a paid child rather than the bad field.
export function isLine(value: unknown, max: number): boolean {
  return (
    max > 0 &&
    typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= max &&
    !/\p{Cc}/u.test(value)
  );
}

/// Why a `reviewBound` is not a record this run may hold, or `undefined`. The record is the only
/// permanent account that a head reached `ci` with lanes nobody judged, so all three parts are checked:
/// one that merely existed would read as a disclosure while carrying nothing printable.

export function reviewBoundProblem(value: unknown): string | undefined {
  const rec = value as Record<string, unknown> | null;
  if (typeof rec !== "object" || rec === null || Array.isArray(rec))
    return "outcome reviewBound must be an object";
  if (rec.wave !== "full" && rec.wave !== "fix")
    return "outcome reviewBound.wave must be full or fix";
  if (!Array.isArray(rec.unreviewedLanes))
    return "outcome reviewBound.unreviewedLanes must be an array";
  if (rec.unreviewedLanes.length > LANES_CAP)
    return `outcome reviewBound.unreviewedLanes must hold at most ${String(LANES_CAP)} lanes`;
  for (const [i, lane] of rec.unreviewedLanes.entries())
    if (!isLine(lane, 80))
      return `outcome reviewBound.unreviewedLanes[${String(i)}] must be a short printable single line`;
  return isLine(rec.reason, MAX_REASON_CHARS)
    ? undefined
    : `outcome reviewBound.reason must be a single printable line of at most ${String(MAX_REASON_CHARS)} characters`;
}

export function validatedReviewBound(value: unknown): ReviewBoundRecord | undefined {
  // The refusal above and the reconstruction below read the SAME four fields: `reviewBoundProblem`
  // is the rule, so a second copy of its tests here could only disagree with it.
  if (reviewBoundProblem(value) !== undefined) return undefined;
  const rec = value as Record<string, unknown>;
  return {
    wave: rec.wave === "fix" ? "fix" : "full",
    unreviewedLanes: (rec.unreviewedLanes as string[]).map((lane) => lane.trim()),
    reason: rec.reason as string,
  };
}

const USAGE_COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "turns"] as const;
const TOOL_COUNTERS = ["toolCalls", "toolErrors"] as const;

/**
 * How many dispatch rows one step may record. Exported because `specify` folds two attempts into ONE
 * outcome and clips its merge here rather than keeping a second copy of the bound.
 */
export const DISPATCHES_MAX_ROWS = 16;

/** Is this a duration a child can honestly report? Finite and never negative. A type predicate rather
 *  than `boolean` so a writer that normalises with it (`fixer-truncation.ts`) keeps the narrowed value
 *  instead of re-testing or casting the same field twice. */
export function isMeasure(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * The ONE grammar of a fixer row's `runId`, and the only fix-run-id regex in the product source —
 * exported because a rule two files state is a rule one of them will violate: a reader with its own
 * looser literal silently deleted the fixer row from every review that fixed anything.
 *
 * The shape: the epoch milliseconds `fixRunId` mints, then the `-<arm>-<wave>-<attempt>` composite that
 * `fixRound` builds for the fix-tree creation that made this tree. No sign, no fraction, no exponent — a
 * hand-edited record carries `"1e12"`, `"-5"` and `"1.5"`, all of which `Number()` would accept and no tree
 * name ever has.
 *
 * **Why the letters are admitted rather than the writer narrowed.** The suffix is what keeps the two
 * arms of one round apart: `fixTreeName` is `lean-<issue>-fix-<arm>-<round>-<attempt>-<epoch>`, and a
 * round dispatches a fixer on BOTH arms at the same round and epoch, so a digits-only suffix cannot
 * separate them — and `worktree add --force` ADOPTS a live tree at a path it is handed. The suffix
 * must not be a second free-floating grammar either: `[0-9a-z-]{1,24}` admits exactly the form the
 * writer produces, plus a bounded total length.
 */
export const FIX_RUN_ID = /^[0-9]{13,17}(-[0-9a-z-]{1,24})?$/;

/** Is this a fixer row's tree identity, in the shape `fixRunId` mints? The READER of the same
 * field must ask the same question, so the predicate is owned by the module that owns the grammar.
 */
export function isRunId(value: unknown): boolean {
  return typeof value === "string" && FIX_RUN_ID.test(value);
}

/** How long a recorded stop reason may be — the bound a child's replay is measured against, exported
 * with `isLine` so writer and loader cannot drift on where it sits. */
export const STOP_REASON_MAX = 40;

/** Is this value a usage row of the shape `DispatchUsage` describes? */
function isUsageRow(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const u = value as Record<string, unknown>;
  // A count of tokens is never a fraction and never infinite: `1e400` arrives from JSON as
  // `Infinity`, and an infinite total is a record that reads as evidence and compares against nothing.
  if (!["input", "output", "cacheRead", "cacheWrite", "turns"].every((k) => isCount(u[k])))
    return false;
  // The tool counts are optional (a row written before they existed has none),
  // but a present one is a count like the others.
  if (!TOOL_COUNTERS.every((k) => u[k] === undefined || isCount(u[k]))) return false;
  // `cost` is the one field that is NOT an integer count: `addUsage` in `pi-usage.ts` accumulates a
  // currency total, so a real report carries fractions. It is still finite and non-negative.
  return isMeasure(u.cost);
}

/** Is this an integer count a child reported: a non-negative safe integer? Exported, like `isLine`
 *  and `isMeasure`, for the writer that normalises a child-reported row at its boundary. */
export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Why a `dispatches` array is not a cost record this run may report, or undefined.
 *
 * Each row is one child the step paid for, and the headless result sums these into `usage.byRole`. A
 * row with no role cannot be attributed, a negative cost subtracts from the total, and an `ok` that is
 * not a boolean leaves the reader unable to tell a stopped child from a finished one.
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
    // `runId` is optional, but when present it must be the shape `fixRunId` mints: the reader that
    // puts a resumed attempt onto the tree its crashed self left matches on this field.
    if (row.runId !== undefined && !isRunId(row.runId))
      return `outcome dispatches[${String(i)}].runId must be a decimal epoch-millisecond string`;
    // `stopReason` is optional, and optional the way the child's field is: a row that recorded none
    // carries no key, so an empty value on the record would read as "the child stopped" to a reader
    // comparing against `"length"`. The same silence-is-never-a-pass rule as `role`.
    if (row.stopReason !== undefined && !isLine(row.stopReason, STOP_REASON_MAX))
      return `outcome dispatches[${String(i)}].stopReason must be a short printable single line`;
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
    // Each count is RE-DERIVED from the check rather than cast: `isUsageRow` already proved all six
    // are non-negative safe integers.
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
        ...(u.toolCalls === undefined ? {} : { toolCalls: u.toolCalls as number }),
        ...(u.toolErrors === undefined ? {} : { toolErrors: u.toolErrors as number }),
      },
      ...(row.runId === undefined ? {} : { runId: row.runId as DispatchUsageRow["runId"] }),
      ...(typeof row.stopReason === "string" ? { stopReason: row.stopReason } : {}),
    });
  }
  return out;
}
