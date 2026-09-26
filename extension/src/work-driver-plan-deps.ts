/**
 * work-driver-plan-deps — #849: the dependsOn edges a corrective re-plan
 * dropped. Moved from work-driver-plan-helpers.ts for the AGENTS.md §12
 * 500-line cap; work-driver-plan-helpers.ts re-exports it so the existing
 * importers (runPlan's call site, the smoke tests) keep their paths.
 */

import type { PlanQualityWorkstream } from "./work-driver-plan-helpers.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";

/**
 * #849 — the dependsOn edges a corrective re-plan dropped.
 *
 * The one-shot corrective re-plan is free to MERGE the colliding workstreams
 * (the overlap fix) but not to silently drop a `dependsOn` edge: on the #814
 * cycle the corrective re-plan made the paths disjoint and dropped every
 * dependency, leaving four semantically-coupled workstreams running in
 * parallel from one baseSha — the shape that re-implemented a migration at
 * develop time and parked the cycle at the fence.
 *
 * Match (documented): an edge is PRESERVED if the same two workstream IDs
 * remain connected (`from` depends on `to` in both plans), OR — because the
 * re-plan may RENAME workstream IDs — if a pair of corrective workstreams
 * carry IDENTICAL (normalised, sorted) path sets to the first plan's
 * `from`/`to` pair and remain connected (the path-set signature of the
 * original dependency). An edge is MERGED if both endpoints now lie in ONE
 * corrective workstream (a path set that is a SUPERSET of both old sets —
 * the union the overlap fix produces). A first-plan edge that is neither
 * preserved nor merged is DROPPED. The cycle CONTINUES with the corrective
 * plan (no second re-dispatch per #754's one-shot rule); the drop is
 * recorded as `planQuality: { reason: "dropped-dependencies" }` and surfaced
 * through the same channel as every other reason. Pure: no I/O, no state
 * mutation; the caller (runPlan) invokes it on the first plan's workstreams
 * and the corrective re-plan's workstreams after the re-dispatch returns.
 */
export function findDroppedDependencyEdges(
  first: Record<string, PlanQualityWorkstream>,
  corrective: Record<string, PlanQualityWorkstream>,
): { from: string; to: string }[] {
  const pathKey = (paths: string[]) =>
    [...new Set(paths.map(normaliseDeclaredPath).filter((p) => p.length > 0))].sort().join("\n");
  // Map each corrective plan's path-set to the workstream id that has it,
  // so a renamed first-plan workstream can still be recognised by its
  // path-set signature. First match wins on a duplicate path-set — a
  // corrective plan with two workstreams claiming the same files is
  // itself a defect the plan-quality gate would have caught, so a
  // duplicate here is unreachable in practice (and, if it did happen,
  // treating both as "the same workstream" is the conservative match).
  const byPath = new Map<string, string>();
  for (const id of Object.keys(corrective)) {
    const key = pathKey(corrective[id]?.paths ?? []);
    if (!byPath.has(key)) byPath.set(key, id);
  }
  const dropped: { from: string; to: string }[] = [];
  for (const from of Object.keys(first)) {
    for (const to of first[from]?.dependsOn ?? []) {
      if (!(to in first)) continue; // invalid-dependency; not a real edge
      const correctiveFrom = byPath.get(pathKey(first[from]?.paths ?? []));
      const correctiveTo = byPath.get(pathKey(first[to]?.paths ?? []));
      // PRESERVED (id): the same two ids still exist in the corrective
      // plan and `from` still declares the edge to `to`.
      if (
        from in corrective &&
        to in corrective &&
        (corrective[from]?.dependsOn ?? []).includes(to)
      ) {
        continue;
      }
      // PRESERVED (path-set signature): the re-plan renamed the ids but
      // kept the dependency between the same two workstreams — the pair of
      // corrective workstreams that carries the first plan's `from` / `to`
      // path-set signatures is still connected by a dependsOn edge.
      if (
        correctiveFrom &&
        correctiveTo &&
        (corrective[correctiveFrom]?.dependsOn ?? []).includes(correctiveTo)
      ) {
        continue;
      }
      // MERGED: both endpoints now lie in one corrective workstream — that
      // workstream's normalised path set is a SUPERSET of both old sets
      // (the union the corrective steer's "merge the two workstreams" fix
      // produces). An endpoint whose first-plan path list was EMPTY is never
      // covered by this rule: `[].every(...)` is vacuously true, so without
      // the length guard a corrective workstream that declares any path set
      // would "cover" an empty endpoint and the edge would be read as
      // merged. An empty-paths endpoint was itself a plan-quality defect
      // (empty-paths) — it cannot be evidence that the pair was merged.
      const merged = Object.keys(corrective).some((id) => {
        const paths = new Set(
          (corrective[id]?.paths ?? []).map(normaliseDeclaredPath).filter((p) => p.length > 0),
        );
        const coversFrom = (first[from]?.paths ?? [])
          .map(normaliseDeclaredPath)
          .every((p) => p.length > 0 && paths.has(p));
        const coversTo = (first[to]?.paths ?? [])
          .map(normaliseDeclaredPath)
          .every((p) => p.length > 0 && paths.has(p));
        return (
          (first[from]?.paths.length ?? 0) > 0 &&
          (first[to]?.paths.length ?? 0) > 0 &&
          coversFrom &&
          coversTo
        );
      });
      if (merged) continue;
      dropped.push({ from, to });
    }
  }
  return dropped;
}
