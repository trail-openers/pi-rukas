/**
 * plan-path-shape — the plain-repo-relative-path check for a planner's declared
 * paths, shared by the `report_workstream` companion (which must refuse a bad
 * path inside the child, so the model can correct it in the same dispatch) and
 * the driver's reader (which judges the same call again on the parent side).
 *
 * Kept free of imports on purpose: the companion is loaded into the plan child
 * with `--extension`, and it must not drag the verify/git module graph with it.
 * work-driver-plan-paths.ts re-exports `isPlainRepoRelativePath` so every
 * existing importer keeps its path.
 */

/**
 * True for a path that is plain and repo-relative: no shell metacharacter, no
 * whitespace, no absolute path, no `..` segment.
 */
export function isPlainRepoRelativePath(p: string): boolean {
  const trimmed = p.trim();
  if (trimmed.length === 0) return false;
  // Shell metacharacters that would execute in a shell-built command.
  if (/[`$;&|<>(){}\\\"'\s]/.test(trimmed)) return false;
  // Absolute path (leading /).
  if (trimmed.startsWith("/")) return false;
  // .. traversal (as a segment, not inside a filename like "a..b.ts").
  if (trimmed.split("/").includes("..")) return false;
  return true;
}

/**
 * The planner's path grammar: a repo-relative path that may contain `[ ] ( )`
 * and literal spaces (Next.js `app/[id]/page.tsx`, `app/(group)/page.tsx`,
 * `docs/my file.md`). Every consumer of a declared path passes it as argv or
 * as data, never as shell text, so those characters are not a hazard here.
 * Still refused: shell expansion characters, other whitespace, absolute paths
 * and `..` segments.
 */
export function isPlannedRepoRelativePath(p: string): boolean {
  const trimmed = p.trim();
  if (trimmed.length === 0) return false;
  // Shell expansion and quoting characters, and whitespace other than a space.
  if (/[`$;&|<>{}\\"'\t\r\n\v\f\0]/.test(trimmed)) return false;
  if (trimmed.startsWith("/")) return false;
  if (trimmed.split("/").includes("..")) return false;
  return true;
}

/**
 * Planned paths as they appear in a prompt a model may turn into shell
 * commands: each one double-quoted, so `app/(group)/page.tsx`, `app/[id]/x.ts`
 * and `docs/my file.md` survive being pasted into `git add`. JSON quoting is
 * shell-safe here because the grammar already refuses `$`, backtick and `\`.
 */
export function quotedPaths(paths: readonly string[]): string {
  return paths.map((p) => JSON.stringify(p)).join(", ");
}

/**
 * True when `p` contains a glob/pathspec character (`* ? !`) — the ONE clause
 * the planner's grammar uses to refuse a pattern. `plannedPathProblem` refuses
 * any declared `report_workstream` path containing one, and
 * `planDeclarableSlot` (work-driver-plan-spec-coverage.ts) exempts a spec
 * slot carrying one from the coverage requirement — a slot the planner may
 * not name is not a slot the plan may be demanded to cover. Both call THIS
 * predicate, so the refusal and the exemption cannot drift; the assertion
 * that every exempted slot literal is refused here lives in
 * `test-plan-spec-glob-coverage.ts`.
 *
 * Judged on RAW text: `normaliseDeclaredPath` strips a trailing `*` as
 * markdown markup, so a slot written `src/foo/*` reads as a concrete
 * directory once normalised and would slip past the exemption.
 */
export function hasPathspecChar(p: string): boolean {
  return /[*?!]/.test(p);
}

/**
 * The reason a declared path is refused, or undefined when it is acceptable.
 *
 * Shell-meaningful characters are refused in the RAW string, annotation
 * included: the raw string is what is stored and what quotedPaths renders, so
 * checking only the annotation-stripped copy let `src/a.ts (`id`)` carry a
 * command substitution past the check into a model-run shell (#1652 review).
 *
 * A trailing parenthetical annotation (`src/a.ts (new)`) is planner prose, not
 * part of the path, so the SHAPE checks run on the stripped copy, the same
 * allowance the declared-path normaliser makes. A parenthetical that is a whole
 * path segment (`app/(group)`) is a real name and is kept. A leading `-` (read
 * as a flag by git), a leading `:` or a glob/magic character (git pathspec
 * magic) and a NUL byte are refused on top of the shape check.
 */
export function plannedPathProblem(raw: string): string | undefined {
  if (/[`$;&|<>{}\\"'\t\r\n\v\f\0]/.test(raw)) {
    return `'${raw}' contains a shell-meaningful character`;
  }
  const p = raw
    .trim()
    .replace(/(?<=[^/])\s*\([^()]*\)\s*$/, "")
    .trim();
  if (p.startsWith("-")) return `'${raw}' starts with '-' (it would be read as a flag)`;
  if (p.startsWith(":")) return `'${raw}' starts with ':' (git reads it as pathspec magic)`;
  if (hasPathspecChar(p)) return `'${raw}' contains a glob or pathspec character (* ? !)`;
  if (p.includes("\0")) return `'${raw}' contains a NUL byte`;
  if (!isPlannedRepoRelativePath(p)) {
    return `'${raw}' is not a plain repo-relative path (no absolute paths, '..' segments, tabs or shell metacharacters)`;
  }
  return undefined;
}
