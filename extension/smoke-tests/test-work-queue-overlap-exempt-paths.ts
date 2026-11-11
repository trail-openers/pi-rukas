#!/usr/bin/env bun
/**
 * #2173 — the queue-side half of the exempt-path set: paths that nearly every
 * cycle touches, and therefore must not serialise the queue.
 *
 * Split out of test-work-queue-preflight-overlap.ts for the reason that file
 * already documents for its section 10: it is a third concern alongside that
 * file's pre-dispatch overlap policy — this one is about which paths the
 * overlap predicate IGNORES at all — and three concerns in one file pushed it
 * past AGENTS.md §12's 500-line cap.
 *
 * The regression this locks down: nearly every cycle declares the generated
 * ALWAYS_RUN list and many append an entry to docs/troubleshooting.md, so those
 * two paths collide for almost every pair of groups. The reactive claims gate
 * stopped parking on them in the same change that exempted them HERE, because
 * groupPathsOverlap and predictedPathsCollide are the OTHER half of what
 * serialises a cycle — an exemption on the claims side alone would leave the
 * queue holding a group back for a collision the plan-time gate no longer sees.
 * Basename matching made that worse than a literal overlap: a prose mention of
 * "troubleshooting.md" in one group body matched the full path in another.
 *
 * AC2 is the other direction and the one that would be easy to break quietly:
 * the exemption is the exact repo path and never a source file, so a real
 * overlap still overlaps with the exempt list riding along.
 */

import { predictedPathsCollide } from "../src/work-queue-overlap.ts";
import { type IssueGroup, groupPathsOverlap, overlappingSiblingIds } from "../src/work-queue.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/** One group with a programmable path set. */
function g(id: string, issue: number, paths: string[]): IssueGroup {
  return { id, scope: "", paths, outOfScope: [], issues: [issue] };
}

// ============ 11. #2173 — derived / append-only paths do not serialise the queue
//
// Nearly every cycle declares the generated ALWAYS_RUN list and many append an
// entry to `docs/troubleshooting.md`. The reactive claims gate stopped parking on
// them in the same change that exempted them HERE: these two predicates are the
// other half of what serialises a cycle, and an exemption that lived only on the
// claims side would leave the queue holding a group back for a collision the
// plan-time gate no longer sees. Basename matching made that worse than a literal
// overlap — `troubleshooting.md` in one body matched the full path in another.
{
  const ALWAYS_RUN_PATH = "extension/src/work-driver-verify-always-run.ts";
  const TROUBLESHOOTING = "docs/troubleshooting.md";
  assert(
    groupPathsOverlap(g("a", 1, [ALWAYS_RUN_PATH]), g("b", 2, [ALWAYS_RUN_PATH])) === false,
    "#2173 two groups whose only shared path is the generated ALWAYS_RUN list do NOT overlap",
  );
  assert(
    groupPathsOverlap(g("a", 1, [TROUBLESHOOTING]), g("b", 2, [TROUBLESHOOTING])) === false,
    "#2173 two groups whose only shared path is docs/troubleshooting.md do NOT overlap",
  );
  assert(
    groupPathsOverlap(g("a", 1, [ALWAYS_RUN_PATH, TROUBLESHOOTING]), g("b", 2, [TROUBLESHOOTING])) ===
      false,
    "#2173 a pair overlapping only on exempt paths stays parallel however many of them they share",
  );
  // The basename arm was the sharper half of the defect: a prose mention of the
  // file name collided with the full path in the sibling group.
  assert(
    groupPathsOverlap(g("a", 1, ["troubleshooting.md"]), g("b", 2, [TROUBLESHOOTING])) === false,
    "#2173 a bare basename mention of an exempt file does not collide with its full path",
  );
  assert(
    predictedPathsCollide(["verify-always-run.ts"], [ALWAYS_RUN_PATH]) === false,
    "#2173 predictedPathsCollide exempts the generated list by basename too",
  );
  // A group whose only prediction is an exempt path predicts NOTHING, which is
  // the empty-vs-anything contract rather than a serialisation of the queue.
  assert(
    predictedPathsCollide([TROUBLESHOOTING], ["src/foo.ts"]) === false,
    "#2173 an exempt-only prediction is 'no prediction', not a hold on the sibling",
  );
  // AC2 — the exemption must not weaken a real overlap in any direction.
  assert(
    groupPathsOverlap(g("a", 1, [ALWAYS_RUN_PATH, "src/foo.ts"]), g("b", 2, ["src/foo.ts"])) ===
      true,
    "#2173 AC2 a shared SOURCE file still overlaps when the exempt list rides along",
  );
  assert(
    predictedPathsCollide([ALWAYS_RUN_PATH, TROUBLESHOOTING, "src/foo.ts"], ["src/foo.ts"]) ===
      true,
    "#2173 AC2 the predicted predicate still collides on the source path it shares",
  );
  assert(
    groupPathsOverlap(
      g("a", 1, ["src/troubleshooting.md"]),
      g("b", 2, ["src/troubleshooting.md"]),
    ) === true,
    "#2173 an unrelated file that merely shares the name is NOT exempt (the exemption is the exact repo path)",
  );
  assert(
    overlappingSiblingIds(
      g("a", 1, [ALWAYS_RUN_PATH]),
      [g("a", 1, [ALWAYS_RUN_PATH]), g("b", 2, [ALWAYS_RUN_PATH])],
    ).join(",") === "",
    "#2173 overlappingSiblingIds reports no sibling for the exempt pair alone",
  );
}


console.log(`\nexit ${exit}`);
process.exit(exit);
