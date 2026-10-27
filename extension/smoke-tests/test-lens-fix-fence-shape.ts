#!/usr/bin/env bun
/**
 * #1852 — the two spellings of the lens-fix fence are ONE shape.
 *
 * `workflow-state-schema-lens-fix-fence.ts` says its `fence` field is the
 * `FixPassFence` object itself, spelled a second time because the schema module
 * must not import the admission module. A promise that lives only in a header
 * comment is a promise nobody checks: a field added to `FixPassFence` and not to
 * the snapshot would round-trip through the state file with the field silently
 * absent, and the gate would judge the round's delta against a fence missing the
 * very term the prompt printed.
 *
 * So the check is at COMPILE time. `lib/lens-fix-fence-shape.ts` declares two
 * total conversions between `FixPassFence` and `LensFixFenceSnapshot["fence"]`,
 * and `tsconfig.smoke-tests.json` typechecks this file. A one-sided field change
 * fails `tsc -p tsconfig.smoke-tests.json`; the assertions below only make that
 * failure legible from the test report (and prove the conversions are real
 * functions on real data, not dead types).
 */

import { fixPassFence } from "../src/work-driver-fix-pass-admission.ts";
import {
  type LiveFence,
  type PersistedFence,
  fenceFromSnapshot,
  fenceToSnapshot,
} from "./lib/lens-fix-fence-shape.ts";

let exit = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** A fence with every field present and no two sets equal, so a field dropped by
 *  either conversion shows up as a wrong value rather than a coincidental match. */
function liveFence(): LiveFence {
  return fixPassFence(
    {
      id: "default",
      declared: ["src/a.ts"],
      named: ["src/b.ts"],
      alreadyChanged: ["src/c.ts"],
      outOfScope: ["docs/nope.md"],
      admittingSlots: 2,
    },
    (n) => 3 + n,
  );
}

// The compile-time claim, in the form the gate enforces: both conversions are
// checked by `tsc -p tsconfig.smoke-tests.json`. Their existence in this file IS
// the assertion — if the two shapes diverge, this module does not typecheck and
// the pre-push gate fails on it.
assert(
  typeof fenceToSnapshot === "function" && typeof fenceFromSnapshot === "function",
  "both fence conversions exist (tsc -p tsconfig.smoke-tests.json is what judges their TYPES)",
);

{
  const live = liveFence();
  const persisted = fenceToSnapshot(live);
  const back = fenceFromSnapshot(persisted as PersistedFence);

  // Non-vacuity: the fixture is a real fence, not an empty object.
  assert(
    live.admits.length > 0 && live.helperDirs.size > 0 && live.ceiling > 3,
    `non-vacuity: the fixture fence has admits/helperDirs/ceiling (${live.admits.length}/${live.helperDirs.size}/${live.ceiling})`,
  );

  const scalarOk =
    back.id === live.id &&
    back.ceiling === live.ceiling &&
    back.ceilingBasis === live.ceilingBasis &&
    back.admittingSlots === live.admittingSlots;
  assert(scalarOk, "the scalar fields survive live -> persisted -> live unchanged");

  const arrayOk =
    JSON.stringify(back.admits) === JSON.stringify(live.admits) &&
    JSON.stringify(back.declared) === JSON.stringify(live.declared) &&
    JSON.stringify(back.passChanged) === JSON.stringify(live.passChanged) &&
    JSON.stringify(back.outOfScope) === JSON.stringify(live.outOfScope);
  assert(arrayOk, "the array fields survive the round trip unchanged");

  // The ONE permitted asymmetry: a Set on the live side, an array on the record.
  assert(
    live.helperDirs instanceof Set && Array.isArray(persisted.helperDirs),
    "helperDirs is the only asymmetry: ReadonlySet live, array in the persisted record",
  );
  assert(
    JSON.stringify([...back.helperDirs]) === JSON.stringify([...live.helperDirs]),
    "and the Set's contents survive the round trip",
  );

  // The persisted form is what a state file holds: JSON round-trips it.
  const json = JSON.parse(JSON.stringify(persisted)) as PersistedFence;
  assert(
    JSON.stringify(fenceFromSnapshot(json)) === JSON.stringify(back),
    "the persisted fence is JSON-safe, so the gate rebuilds the same fence it would have",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
