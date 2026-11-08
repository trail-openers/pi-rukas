#!/usr/bin/env bun
/**
 * #2127 — the per-lens advisory turn ceiling (D3, R2).
 *
 * Lens children cost about 15 M tokens each REGARDLESS of diff size, because
 * they burn ~150 turns re-deriving a diff that is already inlined in their
 * prompt. The ceiling gives each lens a turn count scaled to the diff it was
 * handed, so a 24-line diff is paced at its floor rather than at the cap.
 *
 * AC1 / R2: the unit test asserts the emitted TURN COUNT at named changed-line
 * inputs (0, 1, 100, 101, 1100, 1500+) and, separately, the two constants. The
 * turn count is the assertion that separates the curve from a mutant that moves
 * the floor into the formula: `max(40, …)` inside the function body and a
 * `LENS_TURN_FLOOR` export nothing reads both produce the same numbers for most
 * inputs, so the constants are pinned alongside, not instead.
 */

import { LENS_TURN_CAP, LENS_TURN_FLOOR, lensTurnCeiling } from "../src/lens-turn-ceiling.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ── the constants (R2: pinned in their own right, not only through the curve)
assert(LENS_TURN_FLOOR === 40, `LENS_TURN_FLOOR is 40 (got ${LENS_TURN_FLOOR})`);
assert(LENS_TURN_CAP === 150, `LENS_TURN_CAP is 150 (got ${LENS_TURN_CAP})`);

// ── the turn COUNT at named inputs (R2), each an independent claim
for (const [changedLines, expected, why] of [
  [0, 40, "an empty diff still gets the floor — no lens is paced at zero"],
  [1, 40, "one changed line stays at the floor (10 * ceil(1/100) = 10 < 40)"],
  [100, 40, "100 changed lines is still the floor (10 * 1 = 10 < 40)"],
  [101, 40, "a small diff is still the floor: the curve (10 * ceil(101/100) = 20) has not passed it"],
  [400, 40, "the floor is the binding term right up to 400 changed lines"],
  [401, 50, "the first step above the floor is one whole 100-line block, rounded UP"],
  [1100, 110, "mid-curve: 10 turns per 100 lines, well below the cap"],
  [1400, 140, "the last input whose curve value is below the cap"],
  [1500, 150, "1500 changed lines lands exactly on the cap"],
  [1501, 150, "past 1500 the ceiling is the cap, never more"],
  [40000, 150, "an absurd diff is still 150 turns (the cap is a wall, not a slope)"],
] as const) {
  const got = lensTurnCeiling(changedLines);
  assert(got === expected, `${changedLines} changed lines → ${expected} turns (got ${got}): ${why}`);
}

// ── the curve never leaves the [floor, cap] box for any input at all
for (const n of [2, 39, 40, 41, 250, 999, 1000, 1499]) {
  const got = lensTurnCeiling(n);
  assert(
    got >= LENS_TURN_FLOOR && got <= LENS_TURN_CAP,
    `${n} changed lines stays inside [${LENS_TURN_FLOOR}, ${LENS_TURN_CAP}] (got ${got})`,
  );
}

// ── a negative changed-line count cannot produce a ceiling under the floor
assert(
  lensTurnCeiling(-5) === LENS_TURN_FLOOR,
  `a negative input clamps to the floor, not below it (got ${lensTurnCeiling(-5)})`,
);

console.log(`\nexit ${exit}`);
process.exit(exit);
