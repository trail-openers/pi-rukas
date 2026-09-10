/**
 * work-queue-overlap — the #676 pre-dispatch group-overlap gate.
 *
 * Before dispatching two groups of the SAME /work invocation whose
 * groupIssues()-extracted `paths` overlap (below the 0.5 Jaccard merge
 * threshold, or an R3 split marker blocking the union), the queue must
 * serialize them — the reactive plan-time checkAndRegisterClaims() used to be
 * the ONLY check, and it parks the loser only after a full explore+plan
 * dispatch has already been burned. This module is the pure predicate the
 * queue's worker loop consults; the reactive check remains the safety net for
 * the genuinely unpredictable case (LLM-declared paths diverging from the
 * extracted ones) and is unchanged.
 */

import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { IssueGroup } from "./work-queue.ts";

/**
 * Does this group's groupIssues()-extracted path set overlap a sibling
 * group's set from the same invocation?
 *
 * The data is the `paths` union groupIssues() already computed per group
 * (lowercased tokens, possibly a bare basename or a directory-qualified path
 * for the same file — `commands.ts` vs `extension/src/commands.ts`); the gate
 * adds no extraction of its own. Both sides go through
 * `normaliseDeclaredPath` (whitespace, backticks, annotations) plus a
 * casefold, so a predicted overlap cannot be missed by case or annotation
 * differences — a false positive costs one serialised cycle, a false negative
 * costs the wasted explore+plan dispatch this gate exists to prevent.
 *
 * Exact matching rule (symmetric): overlap iff some normalised token of a ∈
 * b's full set, OR some normalised token of b ∈ a's full set, OR a
 * filename-tail (basename) of a ∈ b's basename set, OR a basename of b ∈ a's
 * basename set. Basename comparison only kicks in for tokens that are
 * actually filenames (a `.` after the last path separator), so a
 * directory-only token never false-matches a filename. The rule is symmetric
 * — both sides reduce to the same full + basename sets, so
 * `groupPathsOverlap(a, b) === groupPathsOverlap(b, a)` holds by
 * construction: a bare-basename mention in EITHER group matches a
 * directory-qualified mention in the other (`commands.ts` vs
 * `extension/src/commands.ts`).
 *
 * Empty-vs-anything is NO overlap by contract: an empty `paths` array means
 * groupIssues() extracted nothing predictable (fetch failed, or the body has
 * no anchored path tokens), and serialising those against every sibling would
 * force full sequential execution for unrelated issues. The reactive
 * plan-time claim check remains the safety net for that case.
 */
export function groupPathsOverlap(a: IssueGroup, b: IssueGroup): boolean {
  if (a.paths.length === 0 || b.paths.length === 0) return false;
  const norm = (p: string) => {
    const n = normaliseDeclaredPath(p);
    return n ? n.toLowerCase() : "";
  };
  const base = (p: string) => {
    const tail = p.split("/").pop() ?? p;
    return tail.includes(".") ? tail : "";
  };
  const aFull = new Set(a.paths.map(norm).filter(Boolean));
  const bFull = new Set(b.paths.map(norm).filter(Boolean));
  const aBases = new Set([...aFull].map(base).filter(Boolean));
  const bBases = new Set([...bFull].map(base).filter(Boolean));
  // #676 lens-findings — symmetric on all four comparisons; the previous
  // asymmetric shape (a's full + basename sets only, matched against b's
  // tokens) was accidentally benign and hard to prove.
  for (const p of aFull) if (bFull.has(p)) return true;
  for (const p of bFull) if (aFull.has(p)) return true;
  for (const b of aBases) if (bBases.has(b)) return true;
  for (const b of bBases) if (aBases.has(b)) return true;
  return false;
}

/**
 * The ids of groups whose extracted path sets overlap this one, among the
 * groups of the same invocation. Pure function of the groups array — no
 * dispatch, no fs, no issue bodies.
 */
export function overlappingSiblingIds(group: IssueGroup, all: IssueGroup[]): string[] {
  return all.filter((g) => g.id !== group.id && groupPathsOverlap(group, g)).map((g) => g.id);
}
