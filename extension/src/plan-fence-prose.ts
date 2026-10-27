/**
 * plan-fence-prose — #1862 (a), the fence bound's half: an `outOfScope` entry
 * that is PROSE is dropped when the sentence names a path that covers a path
 * THIS workstream declares itself.
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
 * The rules, and what they refuse to do:
 *
 *   - Only a workstream's OWN declared paths justify a drop. A sibling's fence
 *     naming another workstream's files is the #572 cross-declaration contract
 *     and is never dropped; `outOfScope` entries naming nothing this workstream
 *     declared are kept whatever they say.
 *   - The whole-token rule is `pathTokenIn`: `data.txt` never names `a.txt`, and
 *     a `lib/a` hit never names `lib/ab`. Prose is scanned for each declared
 *     path and for its directory, so "under agents/ and tests/" names a declared
 *     `tests/test_x.py` through its directory, and prose about `docs` cannot name
 *     `docsfoo/`.
 *   - Prose that names no path token is KEPT. There is nothing to compare it
 *     against, and a rule that deletes fences it cannot read is worse than a
 *     useless fence.
 *   - A PROTECTED declaration is never a reason to open a fence
 *     (`isProtectedPath`): `.github/`, `.pi/`, `CODEOWNERS` and `agents.json`
 *     keep whatever fence names them.
 *   - A PATH-SHAPED entry is never judged here — `fenceMatches` is the one
 *     predicate for entries that are paths, and this module returns any entry
 *     that parses as a path untouched. Two grammars for one entry is the drift
 *     #1725 closed.
 *
 * Pure, and it emits no trace: the caller owns the line and the record.
 */

import { plannedPathProblem } from "./plan-path-shape.ts";
import { pathTokenIn } from "./work-driver-declared-path.ts";
import { isProtectedPath } from "./work-driver-doctrine.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";

/** Is this entry a PATH rather than prose? A fence entry is free-form text and
 * the planner's own grammar deliberately allows spaces (`app/(group)/page.tsx`,
 * `docs/my file.md`), so the grammar alone cannot tell a path from a sentence —
 * the field's sentence passes `plannedPathProblem` and would be read as one
 * 100-character filename. The distinguishing mark is a word-separating space:
 * a path may contain one inside a name, but a sentence does. Anything with a
 * space is prose and judged by the token scan below; an entry that is a real
 * path belongs to `fenceMatches`, and this module has no opinion about it. */
function isPathShaped(entry: string): boolean {
  if (/\s/.test(entry)) return false;
  const normalised = normaliseDeclaredPath(entry);
  if (normalised.length === 0) return false;
  return plannedPathProblem(normalised) === undefined;
}

/** Does this prose sentence name `p`, or the directory `p` sits in, as a whole
 * path token? The directory is what prose actually says — a sentence explains
 * that a workstream does not implement `tests/`, it does not enumerate files. */
function proseNames(prose: string, p: string): boolean {
  if (pathTokenIn(prose, p) || pathTokenIn(prose, `${p}/`)) return true;
  const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
  if (dir.length === 0 || dir === ".") return false;
  return pathTokenIn(prose, dir) || pathTokenIn(prose, `${dir}/`);
}

/**
 * The prose entries of `candidates` that fence this workstream's own files, and
 * the declared path each one names (the path the record quotes).
 *
 * `ownPaths` are the workstream's declared paths as stored (raw); they are
 * normalised here, because the entry is compared against what the DEVELOPER is
 * told to edit, not against how the planner spelled it.
 */
export function proseSelfFenceDrops(
  ownPaths: readonly string[],
  candidates: readonly string[],
): Array<{ entry: string; path: string }> {
  const own = [
    ...new Set(ownPaths.map((p) => normaliseDeclaredPath(p)).filter((p) => p.length > 0)),
  ].filter((p) => !isProtectedPath(p));
  if (own.length === 0) return [];
  const drops: Array<{ entry: string; path: string }> = [];
  for (const entry of candidates) {
    if (entry.trim().length === 0) continue;
    if (isPathShaped(entry)) continue;
    const path = own.find((p) => proseNames(entry, p));
    if (path !== undefined) drops.push({ entry, path });
  }
  return drops;
}
