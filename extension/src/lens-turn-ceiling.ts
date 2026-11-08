/**
 * lens-turn-ceiling — the per-lens ADVISORY turn ceiling, scaled to the diff
 * (#2127).
 *
 * Lens children cost about 15 M tokens each regardless of the size of the
 * change they were handed, because they spend the bulk of their turns
 * re-deriving a diff that is already inlined in their prompt: on one measured
 * 24-line diff a single lens took 10 turns and 0.37 M tokens while another took
 * 152 turns and 14.6 M. The cost is the turns, not the work — every turn
 * re-sends a 100 k+ context — so the lever worth pulling is the turn count, and
 * it should mean something the lens can act on rather than an arbitrary number.
 *
 * Hence a ceiling that scales with what the lens was actually given: a small
 * diff is paced at the floor, a large one earns more turns, and nothing runs
 * past the cap.
 *
 * The curve is `min(LENS_TURN_CAP, max(LENS_TURN_FLOOR, 10 * ceil(lines / 100)))`
 * — ten turns per hundred changed lines. `changedLines` is added PLUS removed
 * lines (`summarizeDiffFiles` at the call site), because a deletion needs as
 * much reading as an insertion. The floor exists because a lens on a one-line
 * diff still has to read the diff, decide, and report; the cap because the
 * pre-existing median (~152 turns) is the behaviour this exists to stop, and a
 * ceiling that never bound anything would change nothing.
 *
 * ADVISORY, and that word is the contract (D1). The value is handed to the
 * spawn as `budgetTurns`, which arms the budget-PROGRESS steer: the child is
 * told "turn 20 of 40" at half and "Report your findings now, then end your
 * turn." at 80 %. It never kills, sets no `killCause`, and adds no blocked or
 * incomplete path (AC4). The lens-ending lever remains the wall clock
 * (`PI_ENSEMBLE_LENS_BOUND_MS`, armed beside this at the call site), and a lens
 * that is blocked before a steer lands follows today's rule unchanged (D2).
 *
 * A pure leaf on purpose: no I/O, no clock, no env — the curve is the whole
 * module, which is what lets its unit suite pin the emitted turn count at named
 * inputs rather than a wiring assertion.
 */

import { summarizeDiffFiles } from "./adversarial-diff-cap.ts";

/** The smallest ceiling a lens can be given: enough to read the diff, decide,
 * and report, however small the diff is. */
export const LENS_TURN_FLOOR = 40;

/** The largest: the order of the observed run-away median, so a lens is paced
 * well below the behaviour this change exists to stop. */
export const LENS_TURN_CAP = 150;

/** Turns granted per `LENS_TURN_BLOCK_LINES` changed lines. */
const LENS_TURNS_PER_BLOCK = 10;

/** The divisor of the curve: one block of changed lines. */
const LENS_TURN_BLOCK_LINES = 100;

/**
 * The advisory turn ceiling for a lens handed `changedLines` changed lines.
 *
 * `changedLines` is added + removed lines over the whole diff. A negative or
 * non-finite value is treated as zero, so a malformed count lands on the floor
 * rather than below it — a lens is never paced at no turns at all.
 */
export function lensTurnCeiling(changedLines: number): number {
  const lines = Number.isFinite(changedLines) && changedLines > 0 ? changedLines : 0;
  const scaled = LENS_TURNS_PER_BLOCK * Math.ceil(lines / LENS_TURN_BLOCK_LINES);
  return Math.min(LENS_TURN_CAP, Math.max(LENS_TURN_FLOOR, scaled));
}

/**
 * The ceiling for a lens handed this diff TEXT — the whole call `runLensChild`
 * makes, so the counting rule (added + removed over every file the diff
 * attributes) lives beside the curve rather than at the spawn site.
 *
 * The text passed here must be the string the lens prompt INLINES: a ceiling
 * read off a different diff than the one the child reviews paces it against a
 * change it was never shown. A diff no file header appears in counts as zero
 * changed lines and so gets the floor, which is the safe direction — an
 * unparsable diff still has to be reviewed.
 */
export function lensTurnCeilingForDiff(diff: string): number {
  let changedLines = 0;
  for (const file of summarizeDiffFiles(diff).files) {
    changedLines += file.added + file.removed;
  }
  return lensTurnCeiling(changedLines);
}
