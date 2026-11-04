/**
 * spawn-reviewer-isolation — the #1975 choke point, as `spawnSpecialist` calls
 * it (AGENTS.md §12: `spawn.ts` sits at the 500-line cap, so the wrapper lives
 * beside the other `spawn-*` seams and the call site is one expression).
 *
 * Every reviewer child — the six lens passes and the adversarial reviewer —
 * reaches git through `spawnSpecialist`, so wrapping that one call isolates all
 * of them and nothing in `lens-review*.ts` or `adversarial.ts` learns the tree
 * exists. The rules themselves (when a tree is made, what it is detached at,
 * what a failure means) are `reviewer-tree.ts`'s contract; this module adds only
 * the shape the spawn path needs — run the dispatch with a relocated spec, and
 * remove the tree however the dispatch ends.
 */

import { execp } from "./exec.ts";
import { isReviewerRole } from "./review-bounds.ts";
import { resolveHeadSha } from "./review-head-sha.ts";
import { openReviewerTree } from "./reviewer-tree.ts";
import { trace, traceWarn } from "./trace.ts";
import type { DispatchResult, DispatchSpec } from "./types.ts";

/**
 * Run `dispatch` with this spec's child pointed at a throwaway detached tree at
 * the reviewed cwd's HEAD, and remove the tree on every exit — a spawn throw, an
 * abort, a cap kill.
 *
 * The spec reaches `dispatch` unchanged whenever relocation is not possible: not
 * a reviewer role, no caller-named cwd (the process cwd is not ours to
 * relocate), the operator's opt-out, an unresolvable HEAD, or a tree git refused
 * to make. Each of those traces rather than throws — a reviewer is a gate, and
 * gate plumbing that cannot start must not cost the gate its answer.
 */
export async function runWithReviewerTree(
  spec: DispatchSpec,
  dispatch: (spec: DispatchSpec) => Promise<DispatchResult>,
): Promise<DispatchResult> {
  if (spec.cwd === undefined || !isReviewerRole(spec.role)) return dispatch(spec);
  const reviewedCwd = spec.cwd;
  const headSha = await resolveHeadSha(reviewedCwd, "HEAD", execp);
  // Every fail-open is `traceWarn`-ed, never the DEBUG-gated `trace`: a review
  // that silently read the live tree instead of an isolated one is exactly the
  // fact an operator needs without turning debugging on.
  if (headSha === undefined) {
    traceWarn(
      `reviewer-tree: ${spec.role} runs in the reviewed tree — HEAD did not resolve at ${reviewedCwd}`,
    );
    return dispatch(spec);
  }
  const tree = await openReviewerTree(execp, reviewedCwd, headSha);
  if (tree.kind === "unisolated") {
    traceWarn(`reviewer-tree: ${spec.role} runs in the reviewed tree — ${tree.reason}`);
    return dispatch(spec);
  }
  const treeCwd = tree.cwd;
  trace(`reviewer-tree: ${spec.role} runs in ${treeCwd} at ${headSha.slice(0, 12)}`);
  try {
    return await dispatch({ ...spec, cwd: treeCwd });
  } finally {
    await tree.release();
  }
}
