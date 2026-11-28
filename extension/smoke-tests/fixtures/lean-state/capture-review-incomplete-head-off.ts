/**
 * fixtures/lean-state/capture-review-incomplete-head-off.ts — the capture of the
 * #2667 off-arm golden, run ONCE from a worktree of the base commit.
 *
 * Run it inside a worktree of the commit `PI_ENSEMBLE_LEAN_REVIEW_INCOMPLETE_HEAD`
 * branched from, with `lib/lean-review-incomplete-head-golden.ts` and this file
 * copied in, so every `src/` import resolves inside the pre-feature tree:
 *
 *   cd extension && bun smoke-tests/fixtures/lean-state/capture-review-incomplete-head-off.ts
 *
 * The printed JSON is the content of `review-incomplete-head-2667.json`. It is
 * NEVER re-captured from the current tree: an off-arm golden taken from the build
 * that owns the switch compares the switch with itself.
 */
import { driveReviewThrowArm } from "../../lib/lean-review-incomplete-head-golden.ts";

const { golden } = await driveReviewThrowArm();
console.log(JSON.stringify(golden, null, 2));
