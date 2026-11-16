/**
 * lean/deadline-record — the one field of a run that belongs to the caller's clock, and the rule
 * that lets it into a durable record.
 *
 * Split from `state.ts` along the seam the field already had: `state.ts` validates the run, this
 * file owns what the run's deadline means. `deadline.ts` is the other half, and neither reads the
 * other, so the record's shape cannot drift from the reader's rules without a type error where
 * they meet (`lean/engine.ts`).
 */

import { LeanStateError } from "./state.ts";

/**
 * Below this an epoch is in seconds, not ms. The SAME floor `work`'s reader applies
 * (`EPOCH_MS_FLOOR` in `work-driver-deadline.ts`): a lean run and a `work` cycle handed the same
 * hand-edited value must not disagree about whether it is a clock. `work` treats a value below
 * the floor as UNSET; lean REFUSES it, because a run that silently lost its deadline would keep
 * working past the caller's kill instead of parking.
 */
const EPOCH_MS_FLOOR = 1e12;

/**
 * The resolved deadline: a positive finite epoch ms, or nothing.
 *
 * The loop re-reads this as its clock, so a hand-edited `0` would stop every step and an epoch in
 * SECONDS would stop none — the same silent no-deadline an operator would never spot. The ONE site
 * that enforces it is `state.ts`'s record validator, which every load passes through, so a corrupt
 * value never reaches a drive and there is no second copy of the rule to drift.
 */
export function assertDeadline(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < EPOCH_MS_FLOOR)
    throw new LeanStateError("deadlineMs must be a positive finite epoch ms");
  return value;
}
