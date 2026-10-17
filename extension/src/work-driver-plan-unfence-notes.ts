/**
 * work-driver-plan-unfence-notes — #1167: the two notes the plan-time unfence
 * writes, and the one question it asks of the plan.
 *
 * Split out of work-driver-plan-unfence.ts for the AGENTS.md §12 line cap.
 * These are the strings an operator reads in a handoff, so the wording lives
 * in one place and the tests assert against it rather than a paraphrase:
 *
 *   - `unfenced <path>: named by the issue` — the fence is gone and the issue
 *     is the authority that removed it (the operator's wording from #1167).
 *   - `unresolved identifier <name>: <candidates>` — the pass could not say
 *     which file a symbol lives in, so it unfenced NOTHING and said why.
 *     Silence here would be indistinguishable from "the issue named nothing",
 *     which is how an extraction bug reads as a clean plan.
 *
 * `ownerOf` is the ownership question the two carve-outs turn on: a path a
 * sibling declares keeps its fence for every non-owner (#572), and a path
 * nobody declares is the only one that can be placed.
 */

import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { Workstream } from "./workflow-state-schema.ts";

/** The note the operator sees when a fence the issue contradicts is removed. */
export function unfencedNote(path: string): string {
  return `unfenced ${path}: named by the issue`;
}

/** The note the operator sees when a symbol could not be resolved to one file. */
export function unresolvedIdentifierNote(name: string, candidates: string[], ref: string): string {
  return candidates.length === 0
    ? `unresolved identifier ${name}: no defining file at ${ref}`
    : `unresolved identifier ${name}: ${candidates.slice(0, 5).join(", ")}`;
}

/**
 * The workstream that declares `path`, or `undefined` when none does. Matching
 * is normalised and containment-aware in both directions (`src/foo` owns
 * `src/foo/bar.ts`, and a fence naming `src/foo` covers `src/foo/bar.ts`), so
 * an annotated or directory-shaped entry cannot dodge the ownership question.
 */
export function ownerOf(workstreams: Record<string, Workstream>, path: string): string | undefined {
  for (const id of Object.keys(workstreams)) {
    for (const p of workstreams[id]?.paths ?? []) {
      const n = normaliseDeclaredPath(p);
      if (n === path || n.startsWith(`${path}/`) || path.startsWith(`${n}/`)) return id;
    }
  }
  return undefined;
}

/** The fence entry in `entries` that covers `path` (normalised, containment-aware). */
export function fenceEntryCovering(entries: string[], path: string): string | undefined {
  return entries.find((entry) => {
    const n = normaliseDeclaredPath(entry);
    return n === path || path.startsWith(`${n}/`);
  });
}
