/**
 * test-lean-review-incomplete-head-off-arm — the switch, off, is the base commit's build.
 *
 * `PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_HEAD=0` must produce, byte for byte, what the tree
 * before the feature produced: the same records, the same terminal stamp, the same comment,
 * the same host document. The comparison is against a golden captured ONCE from a worktree of
 * the commit the switch branched from (`fixtures/lean-state/capture-review-incomplete-head-off.ts`),
 * never re-captured here — a golden taken from the build that owns the switch compares the
 * switch with itself.
 *
 * Both arms are compared. The `throw` arm is the feature's own shape and the one an off build
 * could regress; the `done` arm is the ordinary run, whose bytes the feature must not touch at
 * all — a leak onto the completed arm would change every run's comment.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  driveReviewThrowArm,
  type GoldenArm,
  REVIEW_INCOMPLETE_HEAD_FIXTURE,
} from "./lib/lean-review-incomplete-head-golden.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = JSON.parse(
  readFileSync(path.join(HERE, REVIEW_INCOMPLETE_HEAD_FIXTURE), "utf8"),
) as Record<`${GoldenArm}Arm`, unknown>;

/** The switch's off value: only the literal `0` turns the route off, and only there. */
const OFF = "0";

for (const arm of ["throw", "done"] as const) {
  process.env.PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_HEAD = OFF;
  const { golden } = await driveReviewThrowArm(arm);
  const expected = GOLDEN[`${arm}Arm`];
  const actual = JSON.parse(JSON.stringify(golden));
  assert.deepEqual(
    actual,
    expected,
    `off (${arm} arm): the record differs from the base commit's bytes:\n` +
      `  captured: ${JSON.stringify(expected)}\n` +
      `  today:    ${JSON.stringify(actual)}`,
  );
  console.log(`✓ off ${arm} arm: byte identical to the base commit's capture`);
}

// The off value is read at CALL time, so the arms above must not have been decided by a stale
// module constant: a run with the switch back on differs from this golden, which is what makes
// the comparison above an answer rather than a tautology.
delete process.env.PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_HEAD;
const { golden: onArm } = await driveReviewThrowArm("throw");
assert.notDeepEqual(
  onArm,
  GOLDEN.throwArm,
  "on (throw arm): the switch on must differ from the off bytes, or the comparison proves nothing",
);
console.log("✓ on throw arm: differs from the off capture, as the route must");

console.log("\n✓ lean review-incomplete-head off-arm cases passed");
