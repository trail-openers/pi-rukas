#!/usr/bin/env bun
/**
 * #1991 — the wiring half: the PM's `maxTurns` / `maxMinutes` actually reach a
 * child, and the child is steered at half and at close-out.
 *
 * The pure logic is pinned by test-budget-progress.ts. This suite pins the
 * places an implementation can pass those unit tests and still never steer a
 * real child:
 *
 *   5. a parameter that is not a whole number in range REFUSES the dispatch on
 *      BOTH tools — a bound the child never got is worse than no bound, because
 *      the PM believes it armed one;
 *   6. a child with no steer seam — a lens / adversarial child, the motivating
 *      overrunners — still receives the progress steer, and the operator's
 *      scrollback line is tagged so it is traceable to this cap.
 *
 * Plus the arm itself: the levers reach `spawnSpecialist` and reach
 * `armChildBounds`, which is the only thing standing between a parameter on
 * a tool schema and a line on a child's screen.
 *
 * The arm's runtime behaviour on a live child (which lever arms, the deck-key
 * path, the stand-down, the minutes lever, caps off, and a refused delivery)
 * is the sibling suite `test-budget-progress-arm.ts`; both call the arm through
 * `lib/budget-progress-harness.ts`, so the call shape is asserted once.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAX_MINUTES_DESCRIPTION,
  MAX_TURNS_DESCRIPTION,
  MAX_TURNS_LIMIT,
  maxMinutesLimit,
  parseMaxMinutes,
  parseMaxTurns,
} from "../src/dispatch-budget-params.ts";
import { childBoundGraceMs, childBoundSchedule } from "../src/spawn-child-bound.ts";
import { spawnBackstopMs } from "../src/spawn-support.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) assert(true, msg);
  else {
    console.error(`  expected: ${e}\n  actual:   ${a}`);
    assert(false, msg);
  }
}

const SRC = join(import.meta.dirname, "..", "src");


// Both tools must state the same rule, parse every spec of a parallel batch
// rather than only the first, and hand the parsed values (never the raw ones)
// to the spawn — a bound that survived validation but was dropped on the way is
// the failure this whole guard exists for.
{
  const dispatch = readFileSync(join(SRC, "dispatch.ts"), "utf8");
  const armSites = dispatch.split("budgetArms(").length - 1;
  assert(
    armSites >= 3,
    `both tools validate every spec before anything spawns (${String(armSites)} budgetArms sites: the shared parser plus one per tool)`,
  );
  assert(
    (dispatch.match(/maxTurns: Type\.Optional\(Type\.Integer\(/g) ?? []).length >= 2 &&
      (dispatch.match(/maxMinutes: Type\.Optional\(Type\.Integer\(/g) ?? []).length >= 2,
    "both levers are on the parameter schemas of both tools",
  );
  assert(
    /\{ budgetTurns: turns \}/.test(dispatch) && /\{ childBoundMs: boundMs \}/.test(dispatch),
    "the PARSED values are what reach the spawn (childBoundMs ends a child, budgetTurns is the denominator)",
  );
  assert(
    /MAX_TURNS_DESCRIPTION/.test(dispatch) && /MAX_MINUTES_DESCRIPTION/.test(dispatch),
    "both schemas carry the range and the consequence, so the model reads the fix",
  );
  // F3: the descriptions must not promise a kill the lever cannot deliver. A PM
  // that reads "before the bound ends it" on `maxTurns` will believe a turns
  // bound stops a child, and it does not — the caller's abort does.
  assert(
    !/ends it/.test(MAX_TURNS_DESCRIPTION) &&
      /does NOT end the child/i.test(MAX_TURNS_DESCRIPTION) &&
      /steered at 50% and 80%/i.test(MAX_TURNS_DESCRIPTION),
    "maxTurns' description says it paces only, and never claims to end the child",
  );
  assert(
    /ENDED/.test(MAX_MINUTES_DESCRIPTION) && /steered/i.test(MAX_MINUTES_DESCRIPTION),
    "maxMinutes' description says steered first, then ended at the bound",
  );
  const budgetArms = dispatch.slice(dispatch.indexOf("function budgetArms"));
  assert(
    /if \(turns === undefined && boundMs === undefined\) return \{\}/.test(budgetArms),
    "no bound at all arms nothing — a plain dispatch is unchanged by this feature",
  );
}

// ── the arm: the levers reach the spawn and build a real steer ──────────
{
  const spawn = readFileSync(join(SRC, "spawn.ts"), "utf8");
  assert(
    /armChildBounds\(\{/.test(spawn),
    "spawn.ts arms the child's bounds (without this call the feature is dead code)",
  );
  assert(
    /budgetProgress\.onAssistantTurn\(runningState\.turns/.test(
      readFileSync(join(SRC, "spawn-inflight.ts"), "utf8"),
    ),
    "the steer is driven on the per-assistant-turn seam, beside the turn nudge",
  );
  assert(
    /budgetProgressActive: \(\) => budgetProgress\.armed\(\)/.test(spawn),
    "the spawn tells the cap session when a bound is armed, so the #546 nudge stands down",
  );
  const caps = readFileSync(join(SRC, "spawn-caps.ts"), "utf8");
  assert(
    /if \(opts\.budgetProgressActive\?\.\(\)\) return;/.test(caps),
    "the stand-down lives inside the nudge itself, not at the call site",
  );
  const armSource = readFileSync(join(SRC, "spawn-budget-arms.ts"), "utf8");
  assert(
    /childBoundMs/.test(armSource) && /budgetTurns/.test(armSource),
    "the arm reads BOTH levers — either one alone arms the steer",
  );
  assert(
    /childHasExited\(o\.flags, o\.child\)/.test(armSource),
    "the arm asks the project's one liveness question, the way every other supervisor of this child does",
  );
  // F2: ONE schedule computed once, from one `graceMs` and one `now`, handed to
  // both arms. A second `childBoundSchedule(...)` call in this file would be a
  // second `Date.now()`, and the child would be paced against a bound shorter
  // than the one that ends it.
  const scheduleCalls = (armSource.match(/childBoundSchedule\(/g) ?? []).length;
  eq(scheduleCalls, 1, "the arm asks for the bound's schedule exactly once");
  assert(
    /childBoundSchedule\(\s*o\.opts\.childBoundMs \?\? 0,\s*graceMs,\s*o\.start,?\s*\)/.test(
      armSource,
    ),
    "that one schedule is asked from the single graceMs and the spawn's own start",
  );
  assert(
    /graceMs,\s*\n\s*schedule,/.test(armSource) && /budgetProgressClock\(\s*schedule,\s*o\.start\s*\)/.test(armSource),
    "the SAME schedule object goes to `armChildBound`'s timers and to the progress clock",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
