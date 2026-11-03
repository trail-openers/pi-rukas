/**
 * lean/deadline-record — the one field of a run that belongs to the caller's
 * clock, and the rule that lets it into a durable record (#1920 item 2).
 *
 * Split from `state.ts` at AGENTS.md §12's line cap along the seam the field
 * already had: `state.ts` validates the run, this file owns what the run's
 * deadline means. `deadline.ts` is the other half — reading the contract from
 * the environment and deciding when step work stops — and neither reads the
 * other, so the record's shape cannot drift from the reader's rules without a
 * type error at the one place they meet (`lean/engine.ts`).
 */

import { LeanStateError } from "./state.ts";

/**
 * The deadline's contract on the record: an absolute epoch ms, resolved ONCE by
 * the first step boundary that resolved one and read back from there on every
 * resume. Persisted for the reason `work-driver-deadline.ts` persists it — a
 * duration resolved afresh at each boundary restarts the clock and never parks.
 */
export interface CycleDeadline {
  deadlineMs?: number;
}

/**
 * The resolved deadline: a positive finite epoch ms, or nothing.
 *
 * The loop re-reads this as its clock, so a hand-edited `0` would stop every
 * step and `"1e18"` would stop none. The ONE site that enforces it is
 * `state.ts`'s record validator, which every load passes through; a corrupt
 * value therefore never reaches a drive, and there is no second copy of the
 * rule to drift from the first.
 */
export function assertDeadline(value: unknown, where = "deadlineMs"): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new LeanStateError(`${where} must be a positive finite number`);
  return value;
}
