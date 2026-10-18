#!/usr/bin/env bun
/**
 * #1647 review round 3 — the pure verdicts of the selected verify, with no exec:
 *
 *   - a test that prints a failure line on base but none on this change is NOT
 *     excused (the same failure cannot be shown), while a test with no line on
 *     either side keeps the name-only verdict;
 *   - a probe that names a change-caused test, or fails to name every test, blocks;
 *   - the first run's plan: develop blocks on a timed-out or unnamed failure, ci
 *     reruns it, a named failure reruns its IDs.
 */
import {
  firstRunPlan,
  judgeProbe,
  signatureClash,
} from "../src/work-driver-verify-select-verdict.ts";
import {
  ATTRIBUTION_BEGIN,
  ATTRIBUTION_END,
  replaceAttributionBlock,
} from "../src/work-driver-verify-select-render.ts";

let exit = 0;
const assert = (c: boolean, m: string) => {
  if (c) console.log(`✓ ${m}`);
  else {
    console.error(`✗ ${m}`);
    exit = 1;
  }
};

const T = "smoke-tests/test-a.ts";
const U = "smoke-tests/test-b.ts";

// Signed on base, unsigned on this change: blocks, and names the test.
{
  const clash = signatureClash([T], new Map(), new Map([[T, "expected 1 got 2"]]));
  assert(
    clash !== undefined && "reason" in clash && clash.reason.includes("prints no failure line"),
    "a test with a base failure line and no change failure line is not excused",
  );
}
// Unsigned on base, signed on this change: the name-only verdict stands.
{
  const clash = signatureClash([T], new Map([[T, "boom"]]), new Map());
  assert(
    clash !== undefined && "unsigned" in clash && clash.unsigned.join() === T,
    "a test with no base failure line keeps the name-only verdict",
  );
}
// Same line on both sides: excused.
{
  const clash = signatureClash([T], new Map([[T, "boom"]]), new Map([[T, "boom"]]));
  assert(clash === undefined, "the same failure line on both runs is excused");
}

// A probe that names a change-caused test blocks.
{
  const v = judgeProbe([T], { preExistingFailures: [], changeCausedFailures: [T] }, new Map());
  assert(
    "blocks" in v && v.blocks.includes("green on base"),
    "a change-caused name blocks the probe",
  );
}
// A probe that does not show every probed test red on base blocks.
{
  const v = judgeProbe([T, U], { preExistingFailures: [T], changeCausedFailures: [] }, new Map());
  assert(
    "blocks" in v && v.blocks.includes("not shown to be red"),
    "an unshown test blocks the probe",
  );
}

// The first run's plan.
{
  assert(
    firstRunPlan([T], false, false).kind === "rerun-named",
    "develop reruns a named failure by ID",
  );
  assert(firstRunPlan([], false, false).kind === "block", "develop blocks an unnamed failure");
  assert(firstRunPlan([T], true, false).kind === "block", "develop blocks a timed-out run");
  assert(
    firstRunPlan([], false, true).kind === "rerun-whole",
    "ci reruns an unnamed failure whole",
  );
  assert(firstRunPlan([T], true, true).kind === "rerun-whole", "ci reruns a timed-out run whole");
}

// The block replaces in place and converges; a half-marked body is refused.
{
  const block = `${ATTRIBUTION_BEGIN}\n## Flaky tests\n${ATTRIBUTION_END}`;
  const once = replaceAttributionBlock("intro", block);
  assert(replaceAttributionBlock(once, block) === once, "writing the same block twice converges");
  const other = `${ATTRIBUTION_BEGIN}\n## Flaky tests\n- \`${U}\`\n${ATTRIBUTION_END}`;
  const replaced = replaceAttributionBlock(once, other);
  assert(
    replaced.split(ATTRIBUTION_BEGIN).length === 2 && replaced.includes(U) && !replaced.includes(T),
    "a new block replaces the old one",
  );
  assert(
    replaceAttributionBlock("intro", "") === "intro",
    "an empty block over no markers is a no-op",
  );
  let threw = false;
  try {
    replaceAttributionBlock(ATTRIBUTION_BEGIN, block);
  } catch {
    threw = true;
  }
  assert(threw, "a body with an unpaired marker is refused, not patched");
}

process.exit(exit);
