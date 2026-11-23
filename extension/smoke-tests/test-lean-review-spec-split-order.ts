#!/usr/bin/env bun
/**
 * The split's section ORDER is a contract.
 *
 * One lens brief is a single string that six children read through "Context for
 * this PR:", and the delta arm prepends a capped full-range diff to the same
 * string. So where the criteria sit is not cosmetic: criteria below a truncated
 * diff read as part of it, and criteria above the prose stop being the thing the
 * reviewer judges the diff against.
 *
 * Order asserted: scope line → stripped prose block → criteria section → carried
 * findings → fix delta, on both the full and the whole-branch re-review arm.
 */

import { LEAN_REVIEW_CRITERIA_HEADING } from "../src/lean/review-criteria.ts";
import { lensContext } from "../src/lean/review-deps.ts";
import { makeAssert } from "./lib/lean-engine-fixtures.ts";
import { SPEC_BODY } from "./lib/lean-review-spec-fixture.ts";

const { assert, failures } = makeAssert();

const CARRIED = "- [HIGH] SECURITY src/a.ts:12: a carried row the gate left open";
const DELTA = "## Fixed by the last pass\n- src/a.ts:12 guarded the draw";

/** The first index of each marker in the brief, `-1` when absent. */
type BriefPositions = {
  scope: number;
  prose: number;
  criteria: number;
  carried: number;
  delta: number;
};

function positions(brief: string): BriefPositions {
  return {
    scope: brief.indexOf("/work-lean issue #7"),
    prose: brief.indexOf("What this change was asked to do"),
    criteria: brief.indexOf(LEAN_REVIEW_CRITERIA_HEADING),
    carried: brief.indexOf("OUTSTANDING FROM THE ADVERSARIAL GATE"),
    delta: brief.indexOf("## Fixed by the last pass"),
  };
}

/** `a` strictly before `b`, both present. */
function before(p: BriefPositions, a: keyof BriefPositions, b: keyof BriefPositions): boolean {
  return p[a] !== -1 && p[b] !== -1 && p[a] < p[b];
}

{
  const p = positions(
    lensContext(7, "full", {
      issueBody: SPEC_BODY,
      carried: CARRIED,
      fixDelta: DELTA,
    }),
  );
  assert(
    p.scope === 0,
    "the brief opens with the scope line, not with an issue section",
  );
  assert(before(p, "scope", "prose"), "the scope line precedes the issue block");
  assert(before(p, "prose", "criteria"), "the prose block precedes the criteria section");
  assert(before(p, "criteria", "carried"), "the criteria precede the carried findings");
  assert(before(p, "carried", "delta"), "the carried findings precede the fix delta");

  // The delta arm is the same renderer with the step's own wording: the delta
  // arm must keep the same order, and the criteria must not fall below the delta.
  const deltaArm = positions(
    lensContext(7, "fix", {
      issueBody: SPEC_BODY,
      carried: CARRIED,
      fixDelta: DELTA,
      full: true,
    }),
  );
  assert(
    before(deltaArm, "prose", "criteria") && before(deltaArm, "criteria", "delta"),
    "the whole-branch re-review arm keeps the same order",
  );
}

console.log(`\n${failures() === 0 ? "order green" : "order RED"} (${String(failures())} failing)`);
process.exit(failures());
