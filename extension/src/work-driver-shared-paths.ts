/**
 * work-driver-shared-paths — the paths two cycles may hold AT THE SAME TIME.
 *
 * The plan-time claim gate and the queue's pre-dispatch overlap gate both
 * answer "will these two cycles touch the same file?", and a "yes" serialises
 * them: the reactive check parks the loser at plan, the queue's predicate
 * holds a group back before it dispatches. Both readings are correct for a
 * source file, and were wrong for the two paths almost every cycle declares.
 *
 * Nearly every cycle regenerates the generated ALWAYS_RUN list and many append
 * an entry to `docs/troubleshooting.md`. Neither is a file one cycle owns: the
 * first is regenerated from the tree by the always-run detector, the second is
 * written additively — a cycle appends its own symptom → cause → fix entry and
 * never rewrites a sibling's. Two cycles declaring one of them are not racing
 * to edit the same lines.
 *
 * ONE exported predicate, consulted by BOTH sides: the claims core
 * (`checkCrossGroupClaimsSync`) and both queue predicates (`groupPathsOverlap`,
 * `predictedPathsCollide`). An exemption that lived on one side would delete
 * half the park — the queue would still serialise what the claims gate let
 * through, and vice versa. A real overlap on a source file still serialises.
 *
 * Both sides compare normalised paths, so an entry here is matched after
 * `normaliseDeclaredPath`. The queue predicates fold case; this module folds
 * case too, so an exemption cannot be missed by case, and can only ever REMOVE
 * a collision a stricter comparison would have found — never invent one.
 */

import { normaliseDeclaredPath } from "./work-driver-declared-path.ts";

/**
 * The derived or append-only paths a cycle may declare without reserving them
 * against a sibling, each with the one fact that makes it non-exclusive.
 *
 * The list is the whole of the exemption: adding a path is one row here, and no
 * second list — basenames, prefixes, a per-side copy — can drift from it.
 */
export const SHARED_NON_EXCLUSIVE_PATHS: readonly {
  /** Repo-relative, in the spelling `normaliseDeclaredPath` emits. */
  path: string;
  /** Why two cycles both declaring this path are not racing to edit it. */
  because: string;
}[] = [
  {
    path: "extension/src/work-driver-verify-always-run.ts",
    because: "it is regenerated from the tree by the always-run detector, never hand-edited",
  },
  {
    path: "docs/troubleshooting.md",
    because:
      "each cycle appends its own symptom → cause → fix entry rather than editing a sibling's; a real git conflict in it still parks at consolidation",
  },
];

/**
 * Is this declared path one that two cycles may hold concurrently?
 *
 * Takes the RAW declared spelling — planner markup, annotation, `./` and
 * backticks and all — because the two sides normalise differently (the claims
 * core compares exact normalised strings, the queue predicates casefold on top
 * of that). Normalising here means both ask one question of one function.
 *
 * A path that normalises to nothing is NOT exempt: it reserves nothing anyway,
 * and calling it exempt would let an unnormalisable declaration be the one
 * thing a caller waves through.
 */
export function isSharedNonExclusivePath(declared: string | undefined): boolean {
  if (!declared) return false;
  const normalised = normaliseDeclaredPath(declared);
  if (!normalised) return false;
  const lowered = normalised.toLowerCase();
  return SHARED_NON_EXCLUSIVE_PATHS.some((entry) => entry.path.toLowerCase() === lowered);
}

/**
 * Drop every exempt path from a declared-path list, preserving order. The one
 * filter both sides apply, so "exempt on one side, claimed on the other" is
 * not reachable by a caller that forgot to ask.
 */
export function withoutSharedNonExclusivePaths(
  paths: readonly string[] | undefined,
): string[] {
  return (paths ?? []).filter((p) => !isSharedNonExclusivePath(p));
}
