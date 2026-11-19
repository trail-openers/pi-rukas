/**
 * lean/protected-paths-switch — the ONE reader of the switch over the project's OWN
 * protected paths.
 *
 * Lean has always reverted a developer's edits to the built-in list — `.pi/`,
 * `.github/`, `agents.json`, `CODEOWNERS`, `.gitmodules` — because those decide what
 * the run is judged by. `PI_ENSEMBLE_LEAN_PROTECTED_PATHS` adds the entries a
 * repository states itself in `.pi/work.json` `lean.protectedPaths`: a child's edit to a
 * path matching one of those globs is reverted by the build fold and named in the step's
 * reason, exactly as a built-in one is. Only the literal `"0"` turns them off, and its
 * scope is exactly them: the built-in reverts are `work-driver-doctrine.ts`'s
 * `isProtectedPath`, which this switch never reads, and the process-wide
 * `PI_ENSEMBLE_PROTECTED_PATHS` is not consulted here either — that knob is the classic
 * driver's gate kill-switch and takes the built-ins with it, so a lean run would
 * otherwise lose its revert for a reason the operator aimed somewhere else. With the
 * configured list off, every fold reports and reasons exactly as it did before the field
 * existed.
 *
 * Read at CALL time, not at module load: every lean smoke file runs in one bun process
 * and pins off/on arms with `withEnv`, so a load-time read would let one file's pin
 * disarm the next file's.
 */

/** Whether a project's own `lean.protectedPaths` globs take part in the fold. */
export function leanProtectedPathsEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_PROTECTED_PATHS !== "0";
}
