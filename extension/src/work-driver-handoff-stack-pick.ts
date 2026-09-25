/**
 * work-driver-handoff-stack-pick — #861 (decision 6): the single-recovery-line
 * cherry-pick range for a dependsOn stack.
 *
 * One `git cherry-pick <rootBase>..<tip>` applies every commit of the stack in
 * order — a bare tip pick would leave the ancestors' commits off the feature
 * branch (the wrong text #861 fixes). `rootBase` is the stack root's
 * `workstreamBaseShas` entry when one is recorded, falling back to the cycle's
 * `baseSha`. Split from work-driver-handoff-recovery-caps.ts (AGENTS.md §12
 * 500-line limit).
 */

import type { WorkState } from "./workflow-state.ts";

export function stackPickRange(
  state: WorkState,
  stack: { worktreeId: string; headSha: string }[],
): string {
  const ps = state.pipelineState;
  const tip = stack[0]?.headSha ?? "";
  if (stack.length === 1 && !ps.workstreams) return `git cherry-pick ${tip}`;
  const stackIds = new Set(stack.map((w) => w.worktreeId));
  const roots = stack.filter((w) => {
    const deps = ps.workstreams?.[w.worktreeId]?.dependsOn;
    if (deps === undefined) return false; // untracked → not the pick root
    return deps.every((d) => !stackIds.has(d));
  });
  const root = roots[0];
  const rootBase = (root ? ps.workstreamBaseShas?.[root.worktreeId] : undefined) ?? ps.baseSha;
  return rootBase ? `git cherry-pick ${rootBase}..${tip}` : `git cherry-pick ${tip}`;
}
