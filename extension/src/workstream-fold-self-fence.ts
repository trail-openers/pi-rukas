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
 *     (plan-fence-self-entry.ts), the ONE predicate the fold asks, so the fold
 *     cannot hold a second answer for one entry. What this module adds is the
 *     fold's own bookkeeping: which entries go, and the record of each removal.
 *   - A fence that protects ANYONE but this workstream stays — a sibling's path,
 *     a protected path, or a path no half declared. A drop is a scope widening,
 *     and a widening that silences a fence someone else relies on is the failure
 *     this round exists to close.
 *   - Every drop is an `UnfenceRecord` carrying the note the operator reads, so
 *     the removal is visible in the state file rather than only in `trace()`.
 *
 * Pure: the input arrays are never mutated. The only output beside the return
 * value is a trace line for a fence the sibling guard SAVED (#1862 M3) — silence
 * would be the ordinary case, and the reason a removal did not happen is the
 * thing an operator has to be able to find.
 */

import { neutraliseFenceEntry } from "./plan-fence-render.ts";
import {
  type SelfFenceEntryDrop,
  contradictionPathsByEntry,
  declaredPaths,
  selfFenceEntryDrop,
} from "./plan-fence-self-entry.ts";
import { trace } from "./trace.ts";
import { normaliseDeclaredPath } from "./work-driver-declared-path.ts";
import type { UnfenceRecord } from "./work-driver-plan-unfence-notes.ts";

/** Do two normalised declarations meet on the `/` boundary in either direction?
 * The same containment the fold's own predicate uses, applied to the SIBLING
 * side: `src/a.ts` meets `src/` and `src/a/`, and `src/` meets `src/a.ts`, but
 * `srcfoo` meets nothing (`src` is a name, not a prefix). */
function sharesDeclaredPath(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Every path an entry makes a claim about, for the SIBLING test: the path the
 * drop was granted for, plus every path-shaped token the prose names.
 *
 * The one-path version is what #1862 M3 shipped with, and it is not enough: a
 * sentence is dropped because EVERY token it names belongs to the merged
 * workstream, so a sibling who owns ANY ONE of those tokens owns a file the
 * sentence fences, and the entry is not the merge's to open. `selfFenceEntryDrop`
 * reports only the FIRST owning declaration, so reading that alone keeps a
 * sentence like `"src/a.ts and src/c.ts"` (own `src/`, sibling owns `src/c.ts`)
 * — exactly the walk-into-a-sibling's-file failure this guard exists to stop.
 * The whole set costs one normalisation per token and no extra scan. */
function entryClaimedPaths(entry: string, granted: string): string[] {
  const out: string[] = [];
  for (const word of neutraliseFenceEntry(entry).split(/\s+/)) {
    const token = word
      .replace(/^[,;:({["'`]+/, "")
      .replace(/[,;:)\]}"'`]+$/, "")
      // A trailing `.` is sentence punctuation only at the end of a sentence; an
      // internal one is part of the name (`src/legacy.` is that directory).
      .replace(/(?<=[^\s.])\.(?=\s|$|[)\]}])/, "");
    if (token.length === 0) continue;
    if (!(token.includes("/") || /\.[A-Za-z][A-Za-z0-9]*$/.test(token))) continue;
    const normalised = normaliseDeclaredPath(token);
    if (normalised.length > 0) out.push(normalised);
  }
  // The granted path is always in the set: it is the entry's own text on the
  // path-shaped arm, and a control byte could have hidden it from the split.
  if (!out.some((p) => sharesDeclaredPath(p, granted))) out.push(granted);
  return out;
}

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
  /** Every OTHER workstream's declared paths. A token one of them owns is a
   * SIBLING's file, and a fence over a sibling's file is the fence the fold
   * exists to keep — the developer must not walk into it. Omit it only where the
   * caller genuinely has no sibling view (see `foldTwo`'s `otherDeclared`). */
  siblingPaths?: readonly string[],
): { drop: Set<string>; records: UnfenceRecord[] } {
  const own = declaredPaths(ownPaths);
  const siblings = siblingPaths === undefined ? [] : declaredPaths(siblingPaths);
  const drop = new Set<string>();
  const records: UnfenceRecord[] = [];
  if (own.length === 0 || candidates.length === 0) return { drop, records };
  const contradictions = contradictionPathsByEntry(own, candidates);
  for (const entry of candidates) {
    const decision: SelfFenceEntryDrop = selfFenceEntryDrop(entry, own, contradictions.get(entry));
    if (!decision.drop || drop.has(entry)) continue;
    // #1862 M3 — the entry may fence ONLY the merged workstream's own files.
    // The sibling test reads EVERY path the entry claims (the granted one and
    // every path-shaped token the prose names), not just the path the drop was
    // granted for: if a sibling declares any of them, the entry is not the
    // merged workstream's own business and it stays — said on the trace channel
    // so the reason a removal did not happen is findable.
    const claims = entryClaimedPaths(entry, decision.path);
    const held = siblings.find((p) => claims.some((c) => sharesDeclaredPath(p, c)));
    if (held !== undefined) {
      trace(
        `work-driver: plan fold — kept self-fence ${JSON.stringify(neutraliseFenceEntry(entry))}: ` +
          `${JSON.stringify(neutraliseFenceEntry(held))} is also declared by a sibling workstream`,
      );
      continue;
    }
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
