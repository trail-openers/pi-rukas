#!/usr/bin/env bun
/**
 * #1676 — one explanation for a deferred protected edit.
 *
 * A develop change that edits a protected, ungranted path, and that path is
 * also in the workstream's outOfScope fence, used to produce TWO failures: the
 * protected-path gate's halt (with its --allow-protected instruction) and the
 * scope gate's "declared fence violated". The protected halt is the single
 * explanation, so the scope gate must not repeat it for a path the protected
 * gate already refused. Other fence hits still block.
 */

import { runScopeFanoutGate } from "../src/work-driver-scope-fanout.ts";
import type { FenceViolationRecord } from "../src/work-driver-scope-fence.ts";
import { runProtectedPathGate } from "../src/work-driver-verify-develop-protected.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const FENCE = ".pi/verify-cmd";
const SOURCE = "extension/src/b.ts";

const workstreams = {
  default: { id: "default", scope: "b", paths: [SOURCE], outOfScope: [FENCE] },
};
const changed = () => new Map([["default", new Set([FENCE, SOURCE])]]);

// The protected-path gate, as the develop step runs it: no grant, the path edited.
const protectedFailures: string[] = [];
const protectedNotes: string[] = [];
const refused = runProtectedPathGate({
  protectedGateOn: true,
  touchedPaths: [FENCE, SOURCE],
  protectedOnlyPaths: [],
  protectedGrant: [],
  issues: [1676],
  failures: protectedFailures,
  notes: protectedNotes,
});
assert(refused.join() === FENCE, "the protected-path gate returns the ungranted path it refused");
assert(protectedFailures.length === 1, "the protected-path gate records one failure for it");

// Control: without the refusal the scope gate still fences the edit.
const controlFailures: string[] = [];
runScopeFanoutGate(workstreams, changed(), controlFailures, [], undefined, undefined);
assert(
  controlFailures.some((f) => f.includes(FENCE) && f.includes("declared fence violated")),
  "control: with no protected refusal the scope gate blocks the fenced path",
);

// The refusal present: the scope gate adds no second failure for the path.
const scopeFailures: string[] = [];
const scopeNotes: string[] = [];
const fenceRecords: FenceViolationRecord[] = [];
runScopeFanoutGate(workstreams, changed(), scopeFailures, scopeNotes, fenceRecords, undefined, {
  protectedRefused: refused,
});
assert(scopeFailures.length === 0, "the scope gate adds no failure for a refused protected path");
assert(
  scopeNotes.some((n) => n.includes(FENCE) && n.includes("protected-path gate")),
  "the scope gate names the protected-path gate in a note instead",
);
assert(
  fenceRecords.every((r) => r.file !== FENCE),
  "no fence-violation record is written for the refused path",
);
const explanations = [...protectedFailures, ...scopeFailures].filter((f) => f.includes(FENCE));
assert(explanations.length === 1, "the develop step carries exactly one explanation for the edit");

// A non-canonical spelling is the same path: "./.pi/verify-cmd" in the changed set
// is refused once, by the same normaliser that built the refused set.
const spelledFailures: string[] = [];
const spelledNotes: string[] = [];
runScopeFanoutGate(
  workstreams,
  new Map([["default", new Set([`./${FENCE}`, SOURCE])]]),
  spelledFailures,
  spelledNotes,
  undefined,
  undefined,
  { protectedRefused: [`./${FENCE}`] },
);
assert(
  spelledFailures.length === 0 && spelledNotes.some((n) => n.includes(FENCE)),
  "a ./-spelled changed path matches its refused entry: no failure, one note",
);

// A refusal for a different path does not hide this one.
const otherFailures: string[] = [];
runScopeFanoutGate(workstreams, changed(), otherFailures, [], undefined, undefined, {
  protectedRefused: ["docs/other.md"],
});
assert(
  otherFailures.some((f) => f.includes(FENCE) && f.includes("declared fence violated")),
  "a refusal for another path leaves the fence hit blocking",
);

// The gate off: nothing is refused, so nothing is returned.
const offFailures: string[] = [];
const offRefused = runProtectedPathGate({
  protectedGateOn: false,
  touchedPaths: [FENCE],
  protectedOnlyPaths: [],
  protectedGrant: [],
  issues: [1676],
  failures: offFailures,
  notes: [],
});
assert(
  offRefused.length === 0 && offFailures.length === 0,
  "with the protected gate off nothing is refused",
);

console.log(`\nexit ${exit}`);
process.exit(exit);
