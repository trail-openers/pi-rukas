/**
 * work-driver-leaf-selection — #794 (task-b): pick the dependency LEAVES of
 * a workstream graph — the worktrees no other workstream builds on.
 *
 * In a dependsOn stack each dependent's worktree is based on its
 * dependency's tip, so a dependent's committed range already CONTAINS its
 * ancestors' commits. Picking only the leaves therefore lands every commit
 * exactly once; picking every entry instead replays each ancestor once per
 * level of the stack (the #775 replay, both in consolidation and in the
 * handoff recovery commands).
 *
 * Split from work-driver-cherry-pick.ts (AGENTS.md §12 file-size limit);
 * that file re-exports `dependencyLeaves` so existing importers keep their
 * path.
 */

/**
 * The workstreams whose work must be picked for an operator (or the
 * integration batch) to land every commit exactly once. An id is a LEAF
 * when NO other listed workstream depends on it (directly or transitively).
 *
 * With no `dependsOn` declared (pre-#679 state, N=1, or a genuinely
 * parallel plan) every workstream is its own leaf, so the full list is
 * returned — the existing behaviour for the N-disjoint case.
 *
 * Pure + idempotent under iteration: callers pass the snapshot's committed
 * work (a subset of the workstreams map) and the full depends-on map; ids
 * missing from the map are simply leaves. The graph is a DAG (the
 * plan-quality gate guarantees it), so the transitive-closure BFS below
 * always terminates.
 */
export function dependencyLeaves(
  ids: string[],
  dependsOnMap: Record<string, string[]> | undefined,
): string[] {
  const map: Record<string, string[]> = {};
  for (const [id, deps] of Object.entries(dependsOnMap ?? {})) {
    if (ids.includes(id) && deps.length > 0) map[id] = deps;
  }
  const dependentsOf = new Map<string, string[]>();
  for (const [id, deps] of Object.entries(map)) {
    for (const dep of deps) {
      const list = dependentsOf.get(dep) ?? [];
      list.push(id);
      dependentsOf.set(dep, list);
    }
  }
  // Transitive closure per id: every workstream that (transitively) builds
  // on this one.
  const closure = new Map<string, Set<string>>();
  for (const id of ids) {
    const seen = new Set<string>();
    const queue = (dependentsOf.get(id) ?? []).slice();
    while (queue.length > 0) {
      const n = queue.shift();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      for (const m of dependentsOf.get(n) ?? []) {
        if (!seen.has(m)) queue.push(m);
      }
    }
    closure.set(id, seen);
  }
  return ids.filter((id) => (closure.get(id)?.size ?? 0) === 0);
}
