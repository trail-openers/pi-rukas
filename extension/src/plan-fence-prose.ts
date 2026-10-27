/**
 * plan-fence-prose — #1862 (a), the fence bound's half: an `outOfScope` entry
 * that is PROSE is dropped when the WHOLE sentence fences paths THIS workstream
 * declares itself, and only then.
 *
 * Why the bound needs this and `fenceMatches` does not answer it. A fence entry
 * is free-form text, and planners write sentences: the field case was a docs
 * workstream's `"Every file under agents/ and tests/ — this workstream documents,
 * it does not implement"`. Read as a fence that sentence matches nothing (no
 * file is named by it) so it fences nothing at all, while a developer reading it
 * in the prompt is told not to touch two directories the workstream owns. The
 * entry is both useless as a fence and harmful as an instruction, and the only
 * thing that makes it look like a fence is that it names paths.
 *
 * The rules are the ONE predicate in `plan-fence-self-entry.ts`; this module is
 * the tool boundary's adapter that turns a drop into the record shape the state
 * file carries. It holds no rule of its own — the duplicate prose reader that
 * used to live here is what round 1 removed, because two readers drift into two
 * answers for one entry. In short:
 *
 *   - Only a workstream's OWN declared paths justify a drop, and EVERY path token
 *     the entry names must be one of them. An entry that also names a sibling's
 *     path (#572's cross-declaration contract), a protected path, or a path this
 *     workstream does not declare is kept WHOLE: a fence is one instruction, and
 *     a partial removal of a sentence is not something the driver can do.
 *   - Prose that names no path token is KEPT, and a PATH-SHAPED entry belongs to
 *     `fenceMatches` / `findFenceContradictions`, never judged twice (#1725).
 *
 * Pure, and it emits no trace: the caller owns the line and the record.
 */

import { neutraliseFenceEntry } from "./plan-fence-render.ts";
import {
  type SelfFenceEntryDrop,
  contradictionPathsByEntry,
  declaredPaths,
  selfFenceEntryDrop,
} from "./plan-fence-self-entry.ts";
import type { UnfenceRecord } from "./work-driver-plan-unfence-notes.ts";

/** The tool boundary's own wording for a removal: it answers to the FENCE BOUND
 * (the entry was never a usable fence), where the fold's note answers to the
 * merge. Both go through `selfFenceDroppedNote`'s neutralisation of both fields. */
export function proseSelfFenceNote(entry: string, path: string): string {
  return `self-fence dropped: ${JSON.stringify(neutraliseFenceEntry(entry))} covers its own declared ${JSON.stringify(neutraliseFenceEntry(path))}`;
}

/**
 * The entries of `candidates` that fence this workstream's own files, as the
 * `UnfenceRecord`s the caller persists (#1862 round 1: records, not bare
 * `{entry, path}` pairs, so both fence-dropping sites hand the state file the
 * same shape and a drop cannot be recorded in one place and merely traced in
 * the other).
 *
 * `ownPaths` are the workstream's declared paths as stored (raw); they are
 * normalised here, because the entry is compared against what the DEVELOPER is
 * told to edit, not against how the planner spelled it. The path-shaped arm runs
 * once for the whole list (M3), not once per entry.
 */
export function proseSelfFenceDrops(
  ownPaths: readonly string[],
  candidates: readonly string[],
  workstreamId: string,
): UnfenceRecord[] {
  const own = declaredPaths(ownPaths);
  if (own.length === 0 || candidates.length === 0) return [];
  const contradictions = contradictionPathsByEntry(own, candidates);
  const drops: UnfenceRecord[] = [];
  for (const entry of candidates) {
    const decision: SelfFenceEntryDrop = selfFenceEntryDrop(entry, own, contradictions.get(entry));
    if (!decision.drop) continue;
    drops.push({
      workstream: workstreamId,
      path: decision.path,
      entry: neutraliseFenceEntry(entry),
      note: proseSelfFenceNote(entry, decision.path),
    });
  }
  return drops;
}
