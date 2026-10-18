/**
 * git-env — keep an inherited git repository-location environment away from
 * every git command pi-rukas runs or spawns (#1571).
 *
 * pi-rukas addresses every repository by working directory: a child is
 * spawned with `cwd` set to its worktree, and the driver runs git with
 * `cwd: repoRoot` or `cwd: <worktree>`. Git honours the variables below AHEAD
 * of the working directory, so one inherited from the launching shell — a git
 * hook, a `git rebase --exec`, a wrapper that exported `GIT_DIR` — silently
 * retargets those commands. `GIT_DIR` without `GIT_WORK_TREE` is the worst
 * shape: git takes the object database and index from `GIT_DIR` and the work
 * tree from the cwd, exits 0, and a child working in a linked worktree resets
 * the MAIN checkout's index and files. That destroyed a concurrent session's
 * uncommitted work.
 *
 * The rule is to remove them, not to refuse or repair them. No pi-rukas code
 * sets any of them on purpose, so an inherited value is never meant for the
 * child's cwd. Even a consistent `GIT_DIR` + `GIT_WORK_TREE` pair names a
 * different tree from the worktree the child was given. Refusing would fail
 * every dispatch from a hook-launched session for no gain, and since git
 * reports success on the wrong tree, a refusal or a warning has nothing to
 * see after the fact.
 *
 * The scrub is applied to the whole process at activation (index.ts, and
 * headless/cli.ts, which runs the driver without activating the extension),
 * because the driver runs git from many modules. That also removes them from
 * Pi's own bash tool for the session — deliberately: an operator who exports
 * `GIT_DIR` + `GIT_WORK_TREE` (a bare-repo dotfiles setup) would otherwise
 * have every worktree the driver creates read against the dotfiles repo.
 * spawn.ts and the resume reattach scrub their child env as well, so a child
 * is covered even where no activation ran (tests, tools importing spawn).
 *
 * The set is what git itself treats as repository-local (`git rev-parse
 * --local-env-vars`) minus the `-c` config channel (`GIT_CONFIG*`), which
 * carries credentials and settings rather than a location.
 */

export const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
] as const;

/**
 * Remove every git location variable from `env` in place. Returns the names
 * that were present, so a caller can trace what it removed. Uses `delete`:
 * assigning `undefined` to `process.env` stores the string "undefined" on Bun.
 */
export function scrubGitLocation(env: Record<string, string | undefined>): string[] {
  const removed: string[] = [];
  for (const name of GIT_LOCATION_VARS) {
    if (name in env) {
      removed.push(name);
      delete env[name];
    }
  }
  return removed;
}
