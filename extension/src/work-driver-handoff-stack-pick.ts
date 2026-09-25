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

/**
 * The bare `<rootBase>..<tip>` range (no `git cherry-pick` prefix) for a
 * single-leaf stack whose leaf IS the stack root, given its root base — the
 * shape decision (6) emits and the real-git test EXECUTES. Exported so the
 * fixture test builds the range from the REAL root base SHA (read from git)
 * rather than a hand-written fixture `workstreamBaseShas` — a typo in the
 * range FORM (e.g. a reversed order) fails the fixture run, not just a
 * string assertion. `rootBase === undefined` → undefined (no range; the
 * caller falls back to a bare tip pick, matching `stackPickRange`).
 */
export function singleLeafPickRange(rootBase: string | undefined, tip: string): string | undefined {
  return rootBase ? `${rootBase}..${tip}` : undefined;
}
