/**
 * work-driver-fix-pass-fanout — the fix pass's one fan-out ceiling (#1725
 * round 3, bounded again by #1846).
 *
 * Split from `work-driver-adversarial-fix-scope.ts`, which owns the per-file
 * admission ladder. This is the OTHER question the post-pass check asks: not
 * "may this file change" but "has this pass changed too many files to still be
 * doing the work it was asked to do". One ceiling over every admission route
 * (PM decision #1846-3), computed against the declared paths plus the number of
 * distinct ADMITTING spec pattern slots.
 *
 * Two rules live here that are easy to get wrong from the outside, and are the
 * reason this is a module with a stated contract rather than four lines inline:
 *
 *   - the ceiling grows per ADMITTING SLOT, never per admitted file — one slot
 *     is one authorisation (each capped at `SPEC_SLOT_MAX_FILES` inside the
 *     admitter), so a workstream cannot multiply a single slot into an unbounded
 *     ceiling;
 *   - the NUMERATOR excludes a test the coupled-test route admitted. The ceiling
 *     bounds how far a pass may WANDER from its declared scope, and a test that
 *     proves the fix the pass was asked to make is the opposite of wandering —
 *     the route exists precisely so a fix lands with its test. Charging the
 *     ceiling for it parked passes in which every single file had been asked
 *     for, punishing the behaviour the route was built to encourage. Files
 *     admitted by any OTHER route still count, and excluding them instead (the
 *     pre-#1846 shape) let a workstream change an unbounded number of spec-named
 *     files while presenting a numerator of zero.
 */

import type { FixPassFence } from "./work-driver-fix-pass-admission.ts";
import { coupledTestAdmitted } from "./work-driver-fix-pass-admission.ts";
import { listed } from "./work-driver-fix-pass-park-reason.ts";
import { fanoutLimitFor } from "./work-driver-scope-fanout.ts";

/** What the admitter knows about one workstream's spec pattern slots. */
export interface FixPassSlotAccounting {
  /** Distinct slots that admitted at least one file for this workstream. */
  slotCount: number;
  /** The files those slots admitted, for the park reason's disclosure. */
  admittedFiles: string[];
}

/**
 * The ceiling refusal for one pass, or `undefined` when the pass is inside it.
 *
 * `declaredCount` is the length of the plan's declared path list; `names` is
 * every file the post-pass tree reports for this workstream.
 */
export function fixPassFanoutRefusal(
  id: string,
  declaredCount: number,
  names: readonly string[],
  fence: FixPassFence,
  slots: FixPassSlotAccounting,
): string | undefined {
  if (declaredCount === 0) return undefined;
  const limit = fanoutLimitFor(declaredCount + slots.slotCount);
  const counted = names.filter((f) => !coupledTestAdmitted(f, fence));
  if (counted.length <= limit) return undefined;
  return `${id} changed ${counted.length} files (${slots.admittedFiles.length} of them admitted by ${slots.slotCount} spec pattern slot(s): ${listed(slots.admittedFiles)}) — over the fan-out limit ${limit} for its ${declaredCount} declared path(s) plus ${slots.slotCount} admitting slot(s)`;
}
