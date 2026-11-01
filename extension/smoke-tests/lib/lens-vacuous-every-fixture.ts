/**
 * The zero-healthy-lane fixture for the vacuous-`every` arm of
 * `test-lens-coverage-denominator.ts`.
 *
 * Reaching `runLensFanOut` with `results === []` needs a roster whose entries
 * ALL carry an error. Two shapes look like that and are not:
 *
 *   - an installed skills dir with NO `code-review-*` dir at all → `roster`
 *     comes back empty and `runLensReview` diverts to the empty-roster install
 *     exit BEFORE the fan-out, which never computes a denominator at all;
 *   - a `lensChildFn` stub that RETURNS `blocked: true` rows → those rows are
 *     not `results` (they are the roster's blocked rows), so the healthy set is
 *     still full and the liveness test is not vacuous.
 *
 * `blockedRoster()` is the minimal honest shape: one NAMED entry carrying an
 * error, fanned out with no healthy entries. `mkClone({ skills: "unusable" })`
 * is the same shape at the whole-review level (six named lanes that all fail to
 * parse), which is why the two live side by side here and in the shared
 * coverage fixture.
 */

import type { RosterEntry } from "../../src/lens-roster.ts";

/** One roster entry that carries an error, i.e. a lane that never spawns. */
export function blockedRosterEntry(name = "SECURITY"): RosterEntry {
  return { name, skill: `code-review-${name.toLowerCase()}`, error: "spawn failed" };
}

/** The stub `runLensFanOut`'s `modelSlot` receives in these arms: it just runs
 * the lane body, since no real model slot is being contended for. */
export const passthroughModelSlot = async (
  _lens: string,
  fn: () => Promise<unknown>,
): Promise<unknown> => fn();
