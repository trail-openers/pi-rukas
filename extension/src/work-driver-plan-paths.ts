/**
 * work-driver-plan-paths — do two workstreams claim the same file?
 *
 * `runDevelop` fans one developer per workstream into its own worktree, so two
 * declared `paths` lists naming the same file is two developers editing it in
 * parallel. Nothing checked: a repo-wide grep for `overlap|disjoint|intersect`
 * found no workstream-level check anywhere, and the only Jaccard logic groups
 * *issues*, not workstreams.
 *
 * The collision surfaced much later, as a bare `git apply` failure during
 * commit-pr consolidation — a HALT step, after the whole develop and
 * adversarial spend, with an error saying nothing about why two workstreams
 * wanted the same file.
 *
 * Not hypothetical: measured on this host, current cycles are routinely N>1
 * (lantern 664 = 3 workstreams, 673 = 2, 677 = 3).
 */

import { normaliseDeclaredPath } from "./work-driver-verify.ts";

/** A file two workstreams both claimed. */
export interface PathCollision {
  a: string;
  b: string;
  path: string;
}

/**
 * Workstreams that were told to edit the same file.
 *
 * `runDevelop` fans one developer per workstream into its own worktree, so two
 * lists naming the same path is two developers editing the same file in
 * parallel. It surfaced only at commit-pr, as a bare `git apply` failure during
 * consolidation — a HALT step, after the whole develop and adversarial spend,
 * with nothing in the error explaining why.
 *
 * Containment counts, not just equality: a workstream owning `src/foo` and one
 * owning `src/foo/bar.ts` collide. Prefix alone does not — `src/foo` does not
 * contain `src/foobar`, which is why the check appends the separator.
 *
 * Paths are normalised first (`normaliseDeclaredPath`) because they are prose
 * from a planner, not `git` output: without it, `src/a.ts (new)` and `src/a.ts`
 * read as different files and the check is evaded by an annotation.
 */
export function findPathCollisions(
  workstreams: Record<string, { paths: string[] }>,
): PathCollision[] {
  const normalised = Object.entries(workstreams).map(([id, ws]) => ({
    id,
    paths: [...new Set((ws.paths ?? []).map(normaliseDeclaredPath).filter(Boolean))],
  }));
  const collisions: PathCollision[] = [];
  for (let i = 0; i < normalised.length; i++) {
    for (let j = i + 1; j < normalised.length; j++) {
      const a = normalised[i];
      const b = normalised[j];
      if (!a || !b) continue;
      for (const pa of a.paths) {
        for (const pb of b.paths) {
          if (pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)) {
            collisions.push({ a: a.id, b: b.id, path: pa === pb ? pa : `${pa} / ${pb}` });
          }
        }
      }
    }
  }
  return collisions;
}
