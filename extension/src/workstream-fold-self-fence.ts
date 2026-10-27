/**
 * workstream-fold-self-fence — #1862 (a): the ONE question a folded fence list
 * has to answer before it is stored, and the record that says it was answered.
 *
 * `foldTwo` unions both halves' `outOfScope` and drops the entries that name a
 * merged PATH by raw string equality. That catches the cross-declaration
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
 *   - ONLY an entry that covers the SAME workstream's own declared paths goes.
 *     A sibling's fence is the #572 cross-declaration contract and stays; so
 *     does every entry that names nothing this workstream declared.
 *   - A PROTECTED path is never a reason to drop a fence (`isProtectedPath`):
 *     `.github/`, `.pi/`, `CODEOWNERS` and `agents.json` keep their fence even
 *     when an annotated declaration names them.
 *   - Prose that carries no path token at all is KEPT. There is nothing to
 *     compare it against, and inventing a match from free text is how a fence
 *     that means something gets deleted.
 *   - The predicate is `findFenceContradictions`, the one the plan-quality gate
 *     already runs. The coverage gap #1862 names is that that gate runs BEFORE
 *     the fold, so a self-fence the fold creates is never re-checked; running
 *     the same predicate inside the fold is what closes it, and a fourth
 *     containment rule is what this module must not add.
 *
 * Every drop is returned as an `UnfenceRecord` carrying the note the operator
 * reads, so the removal is visible in the state file rather than only in
 * `trace()`.
 */

import { neutraliseFenceEntry } from "./plan-fence-render.ts";
import { pathTokenIn } from "./work-driver-declared-path.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";
import { findFenceContradictions } from "./work-driver-plan-paths.ts";
import type { UnfenceRecord } from "./work-driver-plan-unfence-notes.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";

/** The containment rule `findFenceContradictions` applies to one entry: the
 * declared path it covers, or undefined when it covers none. Exact match, or
 * containment either way on a `/` boundary, with the entry read as a fence
 * (`dir/**` and `dir/*` are the directory `dir`). */
function contradictionPath(entry: string, own: readonly string[]): string | undefined {
  return findFenceContradictions({
    default: { paths: own as string[], outOfScope: [entry] },
  })[0]?.path;
}

/**
 * The note the operator sees when the fold removes a fence that fenced the
 * merged workstream's own files.
 *
 * #1862 PM decision 4: this string begins with NONE of the prefixes
 * `unfenceSummary` counts on (`unfenced `, `kept fence `, `unresolved identifier
 * `), because those counts answer "what did the issue-named pass do" and a fold
 * drop has a different authority — the merge itself. It quotes the neutralised
 * entry, as every other fence note does: the entry is planner-derived text and
 * the note lands in the state file, the handoff and a trace line.
 */
export function selfFenceDroppedNote(entry: string, path: string): string {
  return `self-fence dropped: ${JSON.stringify(neutraliseFenceEntry(entry))} covers ${path} (merged workstream)`;
}

/**
 * The self-fence half of the fold: which entries of `candidates` the merged
 * workstream must NOT keep, and the record of each removal.
 *
 * `ownPaths` are the merged workstream's declared paths (raw, as the fold
 * stores them; they are normalised here). Two readings of an entry, in order:
 *
 *   1. path-shaped — `findFenceContradictions`' containment rule applied to one
 *      workstream, so `tests/`, `tests/**` and an annotated `tests/x.ts (new)`
 *      all cover a declared `tests/test_x.py`;
 *   2. prose — read for whole path tokens with `pathTokenIn`, which is the
 *      field's shape: a sentence that says `tests/` names that directory without
 *      naming any file in it. The token judged is the declared path's own
 *      directory, compared on the `/` boundary the containment rule uses, so
 *      prose about `docs` cannot name `docsfoo/`.
 *
 * Pure: the input arrays are never mutated and nothing is traced.
 */
export function foldSelfFenceDrops(
  workstreamId: string,
  ownPaths: readonly string[],
  candidates: readonly string[],
): { drop: Set<string>; records: UnfenceRecord[] } {
  const own = [
    ...new Set(ownPaths.map((p) => normaliseDeclaredPath(p)).filter((p) => p.length > 0)),
  ];
  if (own.length === 0 || candidates.length === 0) return { drop: new Set(), records: [] };
  // A PROTECTED declaration is not a reason to open a fence. `.github/`, `.pi/`,
  // CODEOWNERS and agents.json are guarded by their own gate, which halts the
  // cycle; letting a fold drop the fence that names one would widen what the
  // cycle may write into, by way of a merge nobody asked for.
  const protectedFree = own.filter((p) => !isProtectedPath(p));
  if (protectedFree.length === 0 || candidates.length === 0)
    return { drop: new Set(), records: [] };
  const drop = new Set<string>();
  const records: UnfenceRecord[] = [];
  for (const entry of candidates) {
    const path = contradictionPath(entry, protectedFree) ?? proseCoveredPath(entry, protectedFree);
    if (path === undefined || drop.has(entry)) continue;
    drop.add(entry);
    records.push({
      workstream: workstreamId,
      path,
      entry,
      note: selfFenceDroppedNote(entry, path),
    });
  }
  return { drop, records };
}

/**
 * Does this prose name a path that covers one of the declared paths?
 *
 * `pathTokenIn` is the whole-token rule — `data.txt` never names `a.txt`, and a
 * `lib/a` hit never names `lib/ab`. A prose fence names the DIRECTORY
 * (`tests/`, `agents/` in the field's sentence) rather than any file inside it,
 * so the token asked of the sentence is each declared path's own directory and
 * the trailing-separator spelling of the same. A directory token covers every
 * file beneath it, which is the containment rule the path-shaped arm applies.
 */
function proseCoveredPath(entry: string, own: readonly string[]): string | undefined {
  for (const p of own) {
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : p;
    if (dir.length === 0 || dir === ".") continue;
    if (pathTokenIn(entry, dir) || pathTokenIn(entry, `${dir}/`)) return p;
  }
  return undefined;
}
