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
 *   - paths — UNION of both halves, deduped on the normalised identity (#1756
 *     part b). The union is never truncated and never clipped for display:
 *     every file either half authorised stays authorised and stays visible.
 *     `foldTwo` returns a plain `Workstream` — no bookkeeping field to strip —
 *     and a fold PASS that wants a duplicate tally accumulates the union itself
 *     and calls `boundPaths` once, instead of re-dedupeing the growing union
 *     for every absorbed workstream.
 *   - outOfScope — union of both halves MINUS anything that fences the merged
 *     workstream's own files: after the merge the absorbed half's files ARE
 *     this workstream's scope, so a fence entry naming one of them would fence
 *     the merged workstream's own files (a self-fence that demotes every fence
 *     hit to a warning — the #849 shape). The #572 cross-declaration contract
 *     is what makes this safe: every file appears in exactly ONE workstream's
 *     `paths`, so the only outOfScope entries that ever overlap the merged
 *     paths are the cross-declared ones, and those are exactly the ones to
 *     drop. #1862 (a) widened that filter from RAW STRING EQUALITY to the one
 *     fence predicate the plan-quality gate uses — `tests/`, `tests/**` and
 *     `tests/x.ts (new)` all fence a declared `tests/test_x.py`, and a PROSE
 *     entry that names `tests/` as a whole path token fences it too (see
 *     workstream-fold-self-fence.ts, which owns both readings). A SIBLING's
 *     fence and a PROTECTED path's fence are never dropped; prose that names no
 *     path is kept. Every drop is an `UnfenceRecord` — the fold reports them on
 *     its own trace line, and the plan step persists them on
 *     `pipelineState.planQuality.unfence`, so a fence the merge removed is
 *     visible in the state file and not only in `trace()`.
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
 * Pure: returns a NEW map; the input is never mutated. It emits NO trace of its
 * own — a crowded plan folds once per absorbed workstream, so a per-fold warning
 * would be N lines for one event. The caller that runs a whole fold pass
 * (`foldToCeiling`, `foldPortPlan`) accumulates the paths union across its folds,
 * bounds it ONCE at the end, and emits one line for the pass. The one thing the
 * fold DOES say out loud is a self-fence it removed (#1862): those are rare,
 * they change what the developer is allowed to touch, and the caller persists
 * them as `UnfenceRecord`s rather than re-deriving them.
 */

import { capFenceList, fenceBoundNotice, fenceWasBounded } from "./plan-fence-bound.ts";
import { clippedField } from "./plan-fence-record.ts";
import { boundPaths, pathsBoundNotice } from "./plan-paths-bound.ts";
import { trace, traceWarn } from "./trace.ts";
import type { UnfenceRecord } from "./work-driver-plan-unfence-notes.ts";
import type { OutOfScopeClip } from "./workflow-state-schema-workstreams.ts";
import type { Workstream } from "./workflow-state-schema.ts";
import { foldSelfFenceDrops } from "./workstream-fold-self-fence.ts";

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
): { workstreams: Record<string, Workstream>; selfFenceDrops: UnfenceRecord[] } {
  const intoWs = map[into];
  if (!intoWs) return { workstreams: map, selfFenceDrops: [] };
  // #1862 M3 — every workstream in the map that is neither half still declares
  // its own files, and a fence over one of them is not the merged pair's to
  // open. The map is the caller's current working copy, so this is the live
  // sibling view at the moment of the fold.
  const siblingDeclared = Object.entries(map)
    .filter(([id]) => id !== into && id !== from)
    .flatMap(([, ws]) => ws.paths);
  const folded = foldTwo(intoWs, absorbed, siblingDeclared);
  const next: Record<string, Workstream> = { ...map, [into]: folded.workstream };
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
  return { workstreams: next, selfFenceDrops: folded.selfFenceDrops };
}

/**
 * #1005 — the fold of one workstream into another (the union rule above),
 * without the sibling re-point. The ceiling fold (a single fold, no re-point
 * needed — the folded id is not a key any other workstream can depend on
 * yet) calls it directly; `foldWorkstream` composes it with the re-point.
 *
 * #1756 part b — returns the merged workstream ITSELF: the shape of a
 * workstream is the same whatever a fold produced it, so no caller has to
 * strip a bookkeeping field by hand (a leftover `duplicatePaths` in a state
 * file is a field no schema declares). A caller that runs a whole fold pass
 * and wants to say how many entries collapsed accumulates the union itself
 * and reports ONCE — `boundPaths` over the accumulated list gives it the two
 * numbers, and it does not re-dedupe the growing union per fold.
 *
 * #1862 — the return is `{ workstream, selfFenceDrops }` rather than a bare
 * `Workstream`. Every one of the four call sites has somewhere to persist the
 * drops (the two fold passes thread them to the plan step's unfence record;
 * the develop merge threads them to its own notes), so the shape change is
 * made once, in the helper, rather than each site re-deriving which fences the
 * merge removed and getting it differently wrong.
 */
export function foldTwo(
  a: Workstream,
  b: Workstream,
  /** #1862 M3 — every OTHER workstream's declared paths, as the caller sees them
   * at the fold. A fence entry is dropped only when it names nothing outside the
   * merged workstream's own scope, and the caller is the only party that knows
   * what the siblings declared: judging against `a` and `b` alone would call a
   * sibling's file "nobody's" and open the fence over it. Omit it when there is
   * no sibling view to hand (a two-workstream test), and the fold falls back to
   * the two halves — the conservative reading, since those two ARE the scope the
   * merged list is measured against. */
  otherDeclared?: readonly string[],
): { workstream: Workstream; selfFenceDrops: UnfenceRecord[] } {
  // #1756 part b — the union dedupes on the normalised identity. It NEVER
  // truncates and never counts for display: the merged workstream authorises
  // every file either half did, and the prompts print all of them.
  const mergedPaths = boundPaths([...a.paths, ...b.paths]).paths;
  const unioned = [...new Set([...a.outOfScope, ...b.outOfScope])];
  // #1862 (a) — the filter is applied ONCE, by the fence predicate, rather than
  // twice: the pre-#1862 shape dropped a raw-equal entry here and judged the
  // rest separately, so the entry that most obviously fenced the merged
  // workstream (a fence that IS one of its paths, or the protected-path append
  // of the same file) left no record at all. `foldSelfFenceDrops` now sees the
  // whole union — raw equality is the cheapest arm of its containment rule —
  // so every removal it makes is one the operator can read in the state file.
  const selfFence = foldSelfFenceDrops(a.id, mergedPaths, unioned, otherDeclared);
  const mergedList = unioned.filter((entry) => !selfFence.drop.has(entry));
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
  // cannot smuggle past the bound a single call was held to. The re-cap is the
  // same event as the tool boundary's bound, so it says the same words on the
  // same channel (#1744 review) — an operator greps one line and finds the
  // fence the fold dropped, whichever pass bounded it — and the line reports
  // ONLY what this fold dropped, because the carried records describe drops
  // the halves' own calls already said out loud.
  const fence = capFenceList(mergedList, carried);
  if (fence.thisPass.cap > 0) {
    fence.clipped.push({ kind: "dropped", reason: "cap", count: fence.thisPass.cap });
  }
  if (fenceWasBounded(fence)) {
    traceWarn(fenceBoundNotice(`plan fold '${a.id}' + '${b.id}'`, fence));
  }
  // One line per SELF-FENCE the fold removed, beside the bound's own line: the
  // records the caller persists say the same thing in the state file, and an
  // operator greps the log for the fence the merge opened. The ENTRY is
  // neutralised by the note builder, so this line cannot be forged from it.
  for (const rec of selfFence.records) trace(`work-driver: plan fold — ${rec.note}`);
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
    workstream: {
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
    },
    selfFenceDrops: selfFence.records,
  };
}
