/**
 * lib/lean-step-deadline-bound-off-arm — the OFF-arm golden of #2660, in one place.
 *
 * `test-lean-step-deadline-bound-off-arm.ts` compares the arm at
 * `PI_ENSEMBLE_LEAN_STEP_DEADLINE_BOUND=0` against
 * `fixtures/lean-step-deadline-bound-off-arm.json`, captured ONCE from `11c1e8a8a7` — the
 * commit before `lean-step-bound.ts` existed — by a script that imported the base tree
 * from a `git archive` of it, so no import in the capture resolved at this checkout's
 * `src/`. Both sides must arm the dispatch the same way, so the row table and the shape
 * of what is compared live here.
 *
 * What the comparison covers, and why: the pre-change arm is two numbers plus the timers
 * built from them — the `childBoundMs` `armBudget` handed the spawn, and the
 * `childBoundSchedule` `armChildBounds` placed its timers with. A derived arm that
 * changed either silently would be an operator's `=0` not meaning the old behaviour, so
 * both are compared key for key. `budgetTurns` and the frozen stall window ride along:
 * they are the other arms of the same object, and a derivation that disturbed them would
 * show here rather than in a suite that only reads the bound.
 *
 * The `stall.fire` callback and the arms' `fired` reader are functions and cannot be
 * captured; they are the same code on both arms (the switch governs only the minutes
 * lever) and are pinned by `test-lean-budgets.ts` / the request-stall suites.
 */

/** The base commit the capture was taken from — the last one without a step bound. */
export const GOLDEN_BASE_COMMIT = "11c1e8a8a73cffcda48583b4a147c785e5c80160";

/** The instant the captured step was armed at, and the deadline that row sat under. */
export const GOLDEN_START_MS = 1_700_000_000_000 + 4_200_000 - 978_000;
export const GOLDEN_DEADLINE_MS = 1_700_000_000_000 + 4_200_000;

/** The panel's allowance and shipped grace, pinned by the capture and the comparison alike. */
export const GOLDEN_ALLOWANCE_MS = 8 * 60_000;
export const GOLDEN_GRACE_MS = 600_000;

/** One row of the table: what the run record said and what the state's row was. */
export interface GoldenRow {
  deadline: boolean;
  minutes: number;
  headless: boolean;
}

/**
 * The table the capture walked and the comparison walks. `minutes: 45` is the field's row —
 * larger than what the deadline leaves, so it is the row the derivation exists to shorten;
 * `3` is smaller, where the derivation must stand down. `headless` marks the row whose
 * dispatch runs on the host channel; it is not an input to the bound (the bound reads the
 * run record and the row alone) and a derivation that read it would be caught by the ON-arm
 * difference assertion, not by the golden.
 */
export const GOLDEN_ROWS: readonly GoldenRow[] = [
  { deadline: true, minutes: 45, headless: false },
  { deadline: true, minutes: 3, headless: false },
  { deadline: true, minutes: 60, headless: false },
  { deadline: true, minutes: 45, headless: true },
  { deadline: false, minutes: 45, headless: false },
  { deadline: false, minutes: 3, headless: false },
];

/** The capture's payload for one row: the arms and the schedule built from them. */
export interface OffArmGolden {
  opts: {
    childBoundMs?: number;
    budgetTurns?: number;
    stall?: { windowMinutes: number; windowMs: number };
  };
  schedule: { wrapAtMs: number; killAtMs?: number; stopInMs: number };
}

export interface OffArmGoldenFile {
  note: string;
  baseCommit: string;
  startMs: number;
  deadlineMs: number;
  rows: Record<string, OffArmGolden>;
}

/** The golden's row key — one function, so the capture and the test cannot disagree. */
export function goldenRowKey(row: GoldenRow): string {
  return `${row.deadline ? "deadline" : "no-deadline"}/minutes=${String(row.minutes)}/headless=${String(row.headless)}`;
}
