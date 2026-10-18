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
 * The reason a declared path is refused, or undefined when it is acceptable.
 * A trailing parenthetical annotation (`src/a.ts (new)`) is planner prose, not
 * part of the path, so it is stripped first — the same allowance the declared-
 * path normaliser makes. A leading `-` (read as a flag by git) and a NUL byte
 * are refused on top of the shared shape check.
 */
export function plannedPathProblem(raw: string): string | undefined {
  const p = raw
    .trim()
    .replace(/\s*\([^()]*\)\s*$/, "")
    .trim();
  if (p.startsWith("-")) return `'${raw}' starts with '-' (it would be read as a flag)`;
  if (p.includes("\0")) return `'${raw}' contains a NUL byte`;
  if (!isPlainRepoRelativePath(p)) {
    return `'${raw}' is not a plain repo-relative path (no absolute paths, '..' segments, whitespace or shell metacharacters)`;
  }
  return undefined;
}
