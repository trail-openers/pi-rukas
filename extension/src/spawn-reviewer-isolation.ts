/**
 * spawn-reviewer-isolation — the #1975 choke point, as `spawnSpecialist` calls
 * it (AGENTS.md §12: `spawn.ts` is at the 500-line cap, so the wrapper lives
 * beside the other `spawn-*` seams and the call site is three lines).
 *
 * The rules themselves — when a tree is made, what it is detached at, and what
 * a failure means — are `reviewer-tree.ts`'s contract. This module is only the
 * shape the spawn path needs: a relocated spec plus a release that never throws.
 */

import { execp } from "./exec.ts";
import { isReviewerRole } from "./review-bounds.ts";
import { resolveHeadSha } from "./review-head-sha.ts";
import { openReviewerTree } from "./reviewer-tree.ts";
import { trace } from "./trace.ts";
import type { DispatchSpec } from "./types.ts";

/**
 * A reviewer child whose `cwd` is a git worktree gets a throwaway detached tree
 * at that cwd's HEAD instead; everything else about the child is untouched.
 *
 * Returns `spec` unchanged whenever relocation is not possible: not a reviewer
 * role, no caller-named cwd (the process cwd is not ours to relocate), the
 * operator's opt-out, an unresolvable HEAD, or a tree git refused to make. Each
 * of those traces rather than throws — a reviewer is a gate, and gate plumbing
 * that cannot start must not cost the gate its answer.
 */
export async function isolateReviewerSpec(
  spec: DispatchSpec,
): Promise<{ spec: DispatchSpec; release: () => Promise<void> }> {
  const none = { spec, release: async () => undefined };
  if (spec.cwd === undefined || !isReviewerRole(spec.role)) return none;
  const reviewedCwd = spec.cwd;
  const headSha = await resolveHeadSha(reviewedCwd, "HEAD", execp);
  if (headSha === undefined) return none;
  const tree = await openReviewerTree(execp, reviewedCwd, headSha);
  if (!tree.cwd) return none;
  const treeCwd = tree.cwd;
  trace(`reviewer-tree: ${spec.role} runs in ${treeCwd} at ${headSha.slice(0, 12)}`);
  return { spec: { ...spec, cwd: treeCwd }, release: () => tree.release?.() ?? Promise.resolve() };
}
