/**
 * lean/submodules-local-switch — the ONE reader of the switch that decides WHERE a lean
 * worktree's submodules come from. Its outer gate is `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0`,
 * which wins over this and stops the step asking git to populate anything at all — so this
 * switch is observable only when that one is on.
 *
 * The failure this gates: git's default answer to "populate this gitlink" is a clone from the URL recorded
 * for it — the one thing a host with no network cannot answer. An offline trial hands back exit 10, an
 * infrastructure verdict about a transport, for bytes the superproject already holds two directories up.
 *
 * With the switch on, each first-level submodule is SEEDED from the superproject: its module store under
 * `.git/modules/<name>` when it has one, else its populated checkout. Seeding runs as TWO commands and both
 * halves are load-bearing: `submodule init` registers the entry under git's own rules, and `submodule
 * update` fills it from a source named as a command-line `-c submodule.<name>.url=<path>` on that one
 * invocation, with the `file`-transport licence on the same call. Neither assignment is durable —
 * `submodule set-url` would write the harness-chosen path into the shared `.git/config`, where it outlives
 * the run — and nothing comes from a `.gitmodules` file, which is base content and, one level down,
 * content of a different repository.
 *
 * A submodule the superproject never had is left alone and disclosed by path.
 *
 * `PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL=0` puts the initialisation back exactly as it was: same listing probe,
 * same single argv, git's own transport policy, same handback message. Only the literal `"0"` turns it off.
 *
 * Read at CALL time, not module load: every lean smoke file runs in one bun process and pins off/on arms
 * with `withEnv`, so a load-time read would let one file's pin disarm the next's.
 */

/** Whether a lean worktree's submodules are seeded from the superproject. */
export function leanSubmodulesLocalEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL !== "0";
}
