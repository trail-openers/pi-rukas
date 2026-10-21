/**
 * workstream-fold — #1005: the ONE workstream fold, shared by the three
 * sites that fold one workstream into another (the MAX_WORKSTREAMS ceiling
 * fold in work-driver-plan-workstreams.ts, the plan-time coupling merge in
 * work-driver-plan-coupling.ts, and the develop fence merge-and-retry in
 * work-develop-fence-merge.ts).
 *
 * Before #1005 each site had its own copy, and the copies had already
 * diverged (out-of-scope handling, the dependsOn re-point, the scope
 * annotation). One helper:
 *
 *   - paths — UNION of both halves.
 *   - outOfScope — union of both halves MINUS the merged paths: after the
 *     merge the absorbed half's files ARE this workstream's scope, so a
 *     fence entry naming one of them would fence the merged workstream's
 *     own files (a self-fence that demotes every fence hit to a warning —
 *     the #849 shape). The #572 cross-declaration contract is what makes
 *     this safe: every file appears in exactly ONE workstream's `paths`,
 *     so the only outOfScope entries that ever overlap the merged paths are
 *     the cross-declared ones, and those are exactly the ones to drop.
 *     The entry-count cap is re-applied to the union (#1744) and each half's
 *     `outOfScopeClipped` records are carried across by ENTRY TEXT — a record
 *     whose entry the fold removed goes with it, and the re-cap says so on the
 *     same trace line the tool boundary uses.
 *   - dependsOn — union of both halves' lists minus the two merged ids,
 *     and every OTHER workstream's dependsOn that named the absorbed id is
 *     re-pointed to the surviving id (the fold returns the full updated map).
 *   - scope — annotated with the absorbed id.
 *   - integrationTest — the surviving half's, else the absorbed half's.
 *   - introduces / consumes (#1322) — union of both halves (absent when both
 *     are empty, so a fold of contract-less halves keeps the old shape).
 *
 * Pure: returns a NEW map; the input is never mutated.
 */

import { capFenceList, clippedField, fenceBoundNotice } from "./plan-fence-bound.ts";
import { traceWarn } from "./trace.ts";
import type { OutOfScopeClip } from "./workflow-state-schema-workstreams.ts";
import type { Workstream } from "./workflow-state-schema.ts";

/**
 * #1005 — fold `from` into `into`. Returns the updated workstreams map with
 * `from` absorbed (its entry gone, `into` carrying the union, and every
 * sibling that depended on `from` now depending on `into`). `absorbed` is
 * the absorbed workstream (the caller already owns it — the coupling merge
 * deletes it from its working copy before applying the folds, and reading
 * it from a map that no longer holds it is the #1005 M5 defect); `into` is
 * read from `map` (the caller's current working copy). When either half is
 * missing the map is returned unchanged.
 */
export function foldWorkstream(
  map: Record<string, Workstream>,
  into: string,
  from: string,
  absorbed: Workstream,
): Record<string, Workstream> {
  const intoWs = map[into];
  if (!intoWs) return map;
  const merged = foldTwo(intoWs, absorbed);
  const next: Record<string, Workstream> = { ...map, [into]: merged };
  delete next[from];
  // Re-point dependsOn edges that pointed at the absorbed id.
  for (const [id, ws] of Object.entries(next)) {
    if (id === into) continue;
    const deps = ws.dependsOn;
    if (deps?.includes(from)) {
      next[id] = {
        ...ws,
        dependsOn: [...new Set(deps.map((d) => (d === from ? into : d)))],
      };
    }
  }
  return next;
}

/**
 * #1005 — the fold of one workstream into another (the union rule above),
 * without the sibling re-point. The ceiling fold (a single fold, no re-point
 * needed — the folded id is not a key any other workstream can depend on
 * yet) calls it directly; `foldWorkstream` composes it with the re-point.
 */
export function foldTwo(a: Workstream, b: Workstream): Workstream {
  const mergedPaths = [...new Set([...a.paths, ...b.paths])];
  const inScope = new Set(mergedPaths);
  const mergedList = [...new Set([...a.outOfScope, ...b.outOfScope])].filter(
    (p) => !inScope.has(p),
  );
  // #1744 — each half's clip records are keyed by their ENTRY TEXT, so carrying
  // them across the fold is a keep-if-still-present filter (capFenceList), not a
  // re-key: a record whose entry the fold removed (a self-fence, or the re-cap)
  // goes with the entry, and every drop lands in one aggregated record per
  // reason. A half's own drop records carry their count forward — the entries
  // were never stored in either half, so nothing here can invalidate them.
  const carried: OutOfScopeClip[] = [
    ...(a.outOfScopeClipped ?? []),
    ...(b.outOfScopeClipped ?? []),
  ];
  // Two halves at the cap union to twice the cap: re-apply it here so the fold
  // cannot smuggle past the bound a single call was held to, recording the drop.
  const fence = capFenceList(mergedList, carried);
  // The re-cap is the same event as the tool boundary's bound, so it says the
  // same words on the same channel (#1744 review) — an operator greps one line
  // and finds the fence the fold dropped, whichever pass bounded it.
  if (fence.entries.length < mergedList.length) {
    traceWarn(fenceBoundNotice(`plan fold '${a.id}' + '${b.id}'`, fence));
  }
  // #1005 — symmetric: drop BOTH merged ids from BOTH halves' dependsOn
  // (the doc's "minus the two merged ids" — the pre-#1005 asymmetry kept
  // b.id in a's own dependsOn, so a self-reference survived the fold).
  const mergedDeps = new Set<string>();
  for (const d of [...(a.dependsOn ?? []), ...(b.dependsOn ?? [])]) {
    if (d !== a.id && d !== b.id) mergedDeps.add(d);
  }
  const union = (x?: string[], y?: string[]): string[] => [
    ...new Set([...(x ?? []), ...(y ?? [])]),
  ];
  const introduces = union(a.introduces, b.introduces);
  const consumes = union(a.consumes, b.consumes);
  return {
    id: a.id,
    scope: `${a.scope} (+merged: ${b.id})`,
    paths: mergedPaths,
    outOfScope: fence.entries,
    ...clippedField(fence.clipped),
    dependsOn: mergedDeps.size > 0 ? [...mergedDeps] : undefined,
    ...((a.integrationTest ?? b.integrationTest)
      ? { integrationTest: a.integrationTest ?? b.integrationTest }
      : {}),
    ...(introduces.length > 0 ? { introduces } : {}),
    ...(consumes.length > 0 ? { consumes } : {}),
  };
}
