/**
 * test-child-env-2352 — what the spawn puts in a child's env that the role-scoped
 * rules read (#2352), kept apart from `test-child-role-env-2352.ts` because that file
 * is at the AGENTS.md §12 line cap and these are new cases, not edits (split along a
 * natural seam rather than compress the existing rows).
 *
 * Group A is the fail-open stamp (C2): the isolation choke point knows which child it
 * left in the reviewed tree, and the env is the only thing that child can be told
 * through. The two arms are the pair the guard depends on — the marker appears for a
 * fail-open and does NOT appear for an ordinary dispatch, so an isolated reviewer is
 * never accidentally narrowed.
 */

import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { UNISOLATED_CHILD_ENV } from "../src/reviewer-tree.ts";
import { CHILD_TMP_ENV } from "../src/write-fence-deletion.ts";
import { firstReviewerWriteOutside, reviewerRootsFrom } from "../src/write-fence-reviewer.ts";

const plan = {
  forge: { socketPath: undefined, configDir: undefined, secret: undefined },
  ready: Promise.resolve(),
} as never;

console.log("── the fail-open stamp reaches the child's env ──");
const childTmp = mkdtempSync(path.join(tmpdir(), "c2-env-"));
// The reviewed tree the fail-open would have left the child in — deliberately
// OUTSIDE the child's scratch, which is the difference the marker has to make.
const target = mkdtempSync(path.join(tmpdir(), "c2-reviewed-"));
const { buildChildEnv } = await import("../src/spawn-child-env.ts");

const ordinary = buildChildEnv("adversarial-developer", plan, undefined, childTmp);
assert.equal(
  UNISOLATED_CHILD_ENV in ordinary,
  false,
  "an ordinary dispatch carries no marker — an isolated reviewer keeps its tree",
);
const narrowed = buildChildEnv("adversarial-developer", plan, undefined, childTmp, true);
assert.equal(narrowed[UNISOLATED_CHILD_ENV], "1", "a fail-open child is marked");
assert.equal(
  buildChildEnv("adversarial-developer", plan, undefined, childTmp, false)[
    UNISOLATED_CHILD_ENV
  ],
  undefined,
  "and only when the choke point actually failed open",
);
assert.equal(
  UNISOLATED_CHILD_ENV,
  "PI_ENSEMBLE_REVIEWER_UNISOLATED",
  "the name is the one the guard reads",
);

console.log("── and the guard reads exactly that name ──");
const rootsMarked = reviewerRootsFrom(
  { [CHILD_TMP_ENV]: childTmp, [UNISOLATED_CHILD_ENV]: narrowed[UNISOLATED_CHILD_ENV] },
  target,
);
assert.ok(
  !rootsMarked.labels.includes(target),
  "the reviewed cwd is not a root for the marked child",
);
assert.ok(
  rootsMarked.labels.includes(childTmp),
  "its own scratch still is (that is where it works)",
);
assert.equal(
  firstReviewerWriteOutside(`touch ${target}/pwned`, rootsMarked) !== undefined,
  true,
  "so a plant at the reviewed tree is refused",
);
assert.equal(
  firstReviewerWriteOutside(`touch ${target}/pwned`, reviewerRootsFrom({ [CHILD_TMP_ENV]: childTmp }, target)),
  undefined,
  "while the same command runs for a child that really was isolated",
);
// Only the literal "1" narrows: any other value is the unmarked behaviour.
assert.equal(
  reviewerRootsFrom({ [CHILD_TMP_ENV]: childTmp, [UNISOLATED_CHILD_ENV]: "0" }, target).labels
    .length,
  reviewerRootsFrom({ [CHILD_TMP_ENV]: childTmp }, target).labels.length,
  'the marker is off on anything but "1", the same convention every other switch uses',
);

console.log("── I3: the residual the redirect leaves, stated where a reader will find it ──");
// `VIPUNE_DATABASE_PATH` is re-exported so reviewers keep their memory, which means a
// `vipune` write goes to a store the bash guard does not aim. That is a known residual,
// and the module that creates the hole is the module that has to say so.
const src = path.resolve(import.meta.dirname, "..", "src");
const scratchDoc = await Bun.file(path.join(src, "reviewer-scratch-home.ts")).text();
assert.ok(
  /vipune`? writes? (are|is|therefore) not|not judged by the write guard/i.test(scratchDoc) &&
    /residual/i.test(scratchDoc) &&
    /VIPUNE_DATABASE_PATH/.test(scratchDoc),
  "the jsdoc states that vipune writes are not judged by the write guard, as a residual",
);
rmSync(childTmp, { recursive: true, force: true });
rmSync(target, { recursive: true, force: true });
console.log("\nchild env / fail-open stamp (#2352 C2, I3): all groups passed");
