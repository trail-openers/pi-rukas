#!/usr/bin/env bun
/**
 * The split's section ORDER is a contract, pinned in both arms.
 *
 * One lens brief is a single string that six children read through "Context for
 * this PR:", and the delta arm prepends a capped full-range diff to the same
 * string. So where the criteria sit is not cosmetic: criteria below a truncated
 * diff read as part of it, and criteria above the prose stop being the thing the
 * reviewer judges the diff against.
 *
 * Order asserted: scope line → stripped prose block → criteria section → carried
 * findings → fix delta. Both arms, because the off arm's order is the one every
 * existing brief depends on.
 */

import { LEAN_REVIEW_CRITERIA_HEADING } from "../src/lean/review-criteria.ts";
import { lensContext } from "../src/lean/review-deps.ts";
import { withEnv } from "./lib/env-scope.ts";
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

for (const value of [undefined, "0"] as const) {
  await withEnv({ PI_ENSEMBLE_LEAN_REVIEW_SPEC_SPLIT: value }, async () => {
    const arm = value === "0" ? "OFF" : "ON";
    const p = positions(
      lensContext(7, "full", {
        issueBody: SPEC_BODY,
        carried: CARRIED,
        fixDelta: DELTA,
      }),
    );
    assert(before(p, "scope", "prose"), `${arm}: the scope line precedes the issue block`);
    assert(before(p, "carried", "delta"), `${arm}: the carried findings precede the fix delta`);
    if (value === "0") {
      // The off arm prints no criteria section at all, so the order it owes is the
      // one every existing brief depends on — and the absence of the section is
      // what makes the off arm's prompt today's prompt.
      assert(
        p.criteria === -1 && before(p, "prose", "carried"),
        `${arm}: no criteria section is printed, and the prose block precedes the carried findings`,
      );
    } else {
      assert(
        before(p, "prose", "criteria"),
        `${arm}: the prose block precedes the criteria section`,
      );
      assert(before(p, "criteria", "carried"), `${arm}: the criteria precede the carried findings`);
    }
    assert(
      p.scope === 0,
      `${arm}: the brief still opens with the scope line, not with an issue section`,
    );
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
      before(deltaArm, "prose", value === "0" ? "carried" : "criteria") &&
        before(deltaArm, value === "0" ? "carried" : "criteria", "delta"),
      `${arm}: the whole-branch re-review arm keeps the same order`,
    );
  });
}

console.log(`\n${failures() === 0 ? "order green" : "order RED"} (${String(failures())} failing)`);
process.exit(failures());
