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
 * the shape the spawn path needs — run the dispatch with a relocated spec whose
 * prompt names the code index to query, and remove the tree however the
 * dispatch ends.
 */

import { execp } from "./exec.ts";
import { isReviewerRole } from "./review-bounds.ts";
import { resolveHeadShaOutcome } from "./review-head-sha.ts";
import { UNISOLATED_CHILD_ENV, codeIndexNote, openReviewerTree } from "./reviewer-tree.ts";
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
 *
 * A fail-open is also marked on the spec (`failOpen`), because the child is about
 * to run in the tree it was meant to be kept out of: that cwd is one of the two
 * roots the reviewer write guard allows (#2352), so a child that lost its isolation
 * would keep the write access an isolated one has. `buildChildEnv` turns the mark
 * into the env name the guard reads; only this function knows which case it is in.
 */
export async function runWithReviewerTree(
  spec: DispatchSpec,
  dispatch: (spec: DispatchSpec) => Promise<DispatchResult>,
): Promise<DispatchResult> {
  if (spec.cwd === undefined || !isReviewerRole(spec.role)) return dispatch(spec);
  const reviewedCwd = spec.cwd;
  // The outcome form, not `resolveHeadSha`: "git could not be asked" (a lock,
  // a hung filter driver) and "HEAD does not resolve" (an empty repo, a bad
  // ref) read the same through the collapsing resolver, but only the first is
  // an infrastructure fault an operator can act on.
  const head = await resolveHeadShaOutcome(reviewedCwd, "HEAD", execp);
  // Every fail-open is `traceWarn`-ed, never the DEBUG-gated `trace`: a review
  // that silently read the live tree instead of an isolated one is exactly the
  // fact an operator needs without turning debugging on.
  if (head.sha === undefined) {
    traceWarn(
      `reviewer-tree: ${spec.role} runs in the reviewed tree — ${
        head.failed
          ? `git could not be asked for HEAD at ${reviewedCwd}`
          : `HEAD does not resolve at ${reviewedCwd}`
      }`,
    );
    return dispatch({ ...spec, failOpen: true });
  }
  const headSha = head.sha;
  const tree = await openReviewerTree(execp, reviewedCwd, headSha);
  if (tree.kind === "unisolated") {
    traceWarn(`reviewer-tree: ${spec.role} runs in the reviewed tree — ${tree.reason}`);
    return dispatch({ ...spec, failOpen: true });
  }
  const treeCwd = tree.cwd;
  trace(`reviewer-tree: ${spec.role} runs in ${treeCwd} at ${headSha.slice(0, 12)}`);
  try {
    const note = tree.indexedRoot ? codeIndexNote(tree.indexedRoot, headSha) : "";
    return await dispatch({ ...spec, cwd: treeCwd, prompt: note + spec.prompt });
  } finally {
    await tree.release();
  }
}
