/**
 * lean/submodules-local-switch — the ONE reader of the switch that decides WHERE a lean
 * worktree's submodules come from. Its outer gate is `PI_ENSEMBLE_LEAN_RUNNER_PREFLIGHT=0`,
 * which wins over this and stops the step asking git to populate anything at all — so this
 * switch is observable only when that one is on.
 *
 * The field failure this gates: `the worktree's submodules could not be initialised: git
 * submodule update --init --recursive — Submodule 'vendor/infogami' (https://github.com/…)
 * Cloning into …`. An offline benchmark trial died there while the superproject it had cloned
 * already held that submodule: the step asked git to populate the gitlink and git obeyed the
 * URL recorded for it — the one thing a host with no network cannot answer. The run handed
 * back at exit 10, an infrastructure verdict about a transport, for bytes on disk two
 * directories up.
 *
 * With the switch on, each first-level submodule is SEEDED from the superproject: its module
 * store under `.git/modules/<name>` when it has one, else its populated checkout. The
 * seeding runs as TWO commands and both halves of that split are load-bearing: `submodule
 * init` registers the entry under git's own rules, and `submodule update` fills it from a
 * source named as a command-line `-c submodule.<name>.url=<path>` on that one invocation, with
 * the `file`-transport licence on the same call. Neither assignment is durable — a `git
 * submodule set-url` would have written the harness-chosen path into the superproject's shared
 * `.git/config`, where it outlives the run and every later git in the operator's checkout reads
 * it — and nothing is taken from a `.gitmodules` file, which is base content and — one level
 * down — content of an entirely different repository.
 *
 * A submodule the superproject never had is left alone and disclosed by path — the step does
 * not reach for the network for it, because a trial host has no network to reach.
 *
 * `PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL=0` puts the initialisation back exactly as it was: the
 * same listing probe, the same single argv, git's own transport policy, and the same handback
 * message — for the operator whose submodule genuinely lives on a remote and whose host can
 * fetch it. Only the literal `"0"` turns the rule off; unset and any other value leave it on.
 *
 * The env var is read at CALL time, not at module load: every lean smoke file runs in one bun
 * process and pins off/on arms with `withEnv`, so a load-time read would let one file's pin
 * silently disarm the rule in the next.
 */

/** Whether a lean worktree's submodules are seeded from the superproject. */
export function leanSubmodulesLocalEnabled(): boolean {
  return process.env.PI_ENSEMBLE_LEAN_SUBMODULES_LOCAL !== "0";
}
