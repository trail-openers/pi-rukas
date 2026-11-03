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
 * Below this an epoch is in seconds, not ms (1e12 ms is September 2001). The
 * SAME floor `work`'s reader applies (`EPOCH_MS_FLOOR` in
 * `work-driver-deadline.ts`): a lean run and a `work` cycle handed the same
 * hand-edited value must not disagree about whether it is a clock. `work` treats
 * a value below the floor as UNSET; lean REFUSES it, as it refuses every corrupt
 * field of a durable record — a run that silently lost its deadline would keep
 * working past the caller's kill instead of parking.
 */
const EPOCH_MS_FLOOR = 1e12;

/**
 * The resolved deadline: a positive finite epoch ms, or nothing.
 *
 * The loop re-reads this as its clock, so a hand-edited `0` would stop every
 * step, `"1e18"` would stop none — and an epoch in SECONDS would stop none
 * either, being a date in 1970 that every boundary has already passed, which is
 * the same silent no-deadline an operator would never spot. The ONE site that
 * enforces it is `state.ts`'s record validator, which every load passes through;
 * a corrupt value therefore never reaches a drive, and there is no second copy
 * of the rule to drift from the first.
 */
export function assertDeadline(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < EPOCH_MS_FLOOR)
    throw new LeanStateError("deadlineMs must be a positive finite epoch ms");
  return value;
}
