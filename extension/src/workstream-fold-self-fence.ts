/**
 * workstream-fold-self-fence — #1862 (a): the ONE question a folded fence list
 * has to answer before it is stored, and the record that says it was answered.
 *
 * `foldTwo` unions both halves' `outOfScope` and used to drop the entries that
 * name a merged PATH by raw string equality. That catches the cross-declaration
 * entries (#572's contract puts a sibling's file in the other half's fence, and
 * after the merge that file is this workstream's own scope) and nothing else,
 * because a fence entry is prose, not a path:
 *
 *   - the sibling half's fence said `tests/` while the merged workstream owns
 *     `tests/test_x.py`, so the developer is told not to touch what it must
 *     change and the develop gate's fence arm judges that file fenced;
 *   - the sibling half's fence said `Every file under agents/ and tests/ — this
 *     workstream documents, it does not implement` over the surviving half's
 *     `agents/` and `tests/` paths. The entry names no path of its own, so the
 *     set-membership filter cannot even see it.
 *
 * What this module decides, and what it deliberately does not:
 *
 *   - The decision itself is NOT here. It lives in `selfFenceEntryDrop`
 *     (plan-fence-self-entry.ts), the ONE predicate the tool boundary asks too,
 *     so the two sites cannot drift into two answers for one entry. What this
 *     module adds is the fold's own bookkeeping: which entries go, and the
 *     record of each removal.
 *   - A fence that protects ANYONE but this workstream stays — a sibling's path,
 *     a protected path, or a path no half declared. A drop is a scope widening,
 *     and a widening that silences a fence someone else relies on is the failure
 *     this round exists to close.
 *   - Every drop is an `UnfenceRecord` carrying the note the operator reads, so
 *     the removal is visible in the state file rather than only in `trace()`.
 *
 * Pure: the input arrays are never mutated and nothing is traced.
 */

import { neutraliseFenceEntry } from "./plan-fence-render.ts";
import {
  type SelfFenceEntryDrop,
  contradictionPathsByEntry,
  declaredPaths,
  selfFenceEntryDrop,
} from "./plan-fence-self-entry.ts";
import type { UnfenceRecord } from "./work-driver-plan-unfence-notes.ts";

/**
 * The note the operator sees when the fold removes a fence that fenced the
 * merged workstream's own files.
 *
 * #1862 PM decision 4: this string begins with NONE of the prefixes
 * `unfenceSummary` counts on (`unfenced `, `kept fence `, `unresolved identifier
 * `), because those counts answer "what did the issue-named pass do" and a fold
 * drop has a different authority — the merge itself. Both the entry and the path
 * are neutralised and the entry is quoted, as every other fence note does: the
 * entry is planner-derived text and the note lands in the state file, the
 * handoff and a trace line. The path is a normalised declaration rather than
 * free text, but it is derived from planner input too, so it is neutralised on
 * the same rule rather than on the assumption that it is clean.
 */
export function selfFenceDroppedNote(entry: string, path: string): string {
  return `self-fence dropped: ${JSON.stringify(neutraliseFenceEntry(entry))} covers ${JSON.stringify(neutraliseFenceEntry(path))} (merged workstream)`;
}

/**
 * The self-fence half of the fold: which entries of `candidates` the merged
 * workstream must NOT keep, and the record of each removal.
 *
 * `ownPaths` are the merged workstream's declared paths (raw, as the fold stores
 * them). The path-shaped arm runs ONCE over the whole candidate list
 * (`contradictionPathsByEntry`, M3) and each entry then looks its answer up, so
 * N entries cost one normalisation of the declarations and one containment pass,
 * not N.
 */
export function foldSelfFenceDrops(
  workstreamId: string,
  ownPaths: readonly string[],
  candidates: readonly string[],
): { drop: Set<string>; records: UnfenceRecord[] } {
  const own = declaredPaths(ownPaths);
  const drop = new Set<string>();
  const records: UnfenceRecord[] = [];
  if (own.length === 0 || candidates.length === 0) return { drop, records };
  const contradictions = contradictionPathsByEntry(own, candidates);
  for (const entry of candidates) {
    const decision: SelfFenceEntryDrop = selfFenceEntryDrop(entry, own, contradictions.get(entry));
    if (!decision.drop || drop.has(entry)) continue;
    drop.add(entry);
    records.push({
      workstream: workstreamId,
      path: decision.path,
      entry: neutraliseFenceEntry(entry),
      note: selfFenceDroppedNote(entry, decision.path),
    });
  }
  return { drop, records };
}
